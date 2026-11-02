const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { GridFSBucket, MongoClient } = require("mongodb");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DOCUMENT_PATH_PATTERN = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.pdf$/;
const UPLOAD_CATEGORIES = new Set([
    "bao-cao",
    "dang-vu",
    "bien-ban",
    "chuyen-de",
    "van-ban-cap-tren",
    "nghi-quyet-tw",
    "tai-lieu-chung"
]);

let cachedClient;
let cachedClientKey;

function getStorageConfiguration() {
    const uri = process.env.MONGODB_URI;
    const database = process.env.MONGODB_DATABASE;
    if (!uri || !database) {
        return null;
    }
    return { uri, database };
}

async function getStorageDatabase(configuration) {
    const clientKey = `${configuration.uri}\u0000${configuration.database}`;
    if (cachedClient && cachedClientKey === clientKey) {
        return cachedClient;
    }

    const client = new MongoClient(configuration.uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10000
    });
    const connection = client.connect().then(async () => {
        const database = client.db(configuration.database);
        await Promise.all([
            database.collection("document_upload_sessions").createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 0 }
            ),
            database.collection("document_upload_chunks").createIndex(
                { uploadId: 1, index: 1 },
                { unique: true }
            ),
            database.collection("document_upload_chunks").createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 0 }
            ),
            database.collection("fs.files").createIndex({ "metadata.path": 1, uploadDate: -1 })
        ]);
        return database;
    }).catch(async (error) => {
        await client.close();
        if (cachedClient === connection) {
            cachedClient = undefined;
            cachedClientKey = undefined;
        }
        throw error;
    });

    cachedClient = connection;
    cachedClientKey = clientKey;
    return connection;
}

function isDocumentPath(value) {
    return typeof value === "string" && DOCUMENT_PATH_PATTERN.test(value);
}

async function listStoredDocuments(database) {
    const files = await database.collection("fs.files")
        .find({ "metadata.path": { $type: "string" } })
        .sort({ uploadDate: -1 })
        .project({ filename: 1, length: 1, uploadDate: 1, "metadata.path": 1 })
        .toArray();
    const documents = new Map();

    for (const file of files) {
        const documentPath = file.metadata?.path;
        if (isDocumentPath(documentPath) && !documents.has(documentPath)) {
            documents.set(documentPath, {
                path: documentPath,
                size: file.length,
                lastModified: file.uploadDate
            });
        }
    }

    return [...documents.values()];
}

async function getStoredDocument(database, documentPath) {
    const file = await database.collection("fs.files")
        .find({ "metadata.path": documentPath })
        .sort({ uploadDate: -1 })
        .limit(1)
        .next();
    if (!file) {
        return null;
    }

    const chunks = [];
    for await (const chunk of new GridFSBucket(database).openDownloadStream(file._id)) {
        chunks.push(chunk);
    }
    return {
        body: Buffer.concat(chunks),
        size: file.length,
        file
    };
}

function safePdfName(fileName) {
    if (typeof fileName !== "string" || !fileName.toLowerCase().endsWith(".pdf")) {
        return null;
    }

    const baseName = fileName.slice(0, -4)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[Đđ]/g, (letter) => letter === "Đ" ? "D" : "d")
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100);

    return baseName ? `${baseName}.pdf` : null;
}

function createNewDocumentPath({ fileName, category, year }) {
    const safeName = safePdfName(fileName);
    if (!safeName || !UPLOAD_CATEGORIES.has(category)) {
        return null;
    }

    const segments = ["uploads", category];
    if (category === "bao-cao") {
        if (!/^(?:19|20|21)\d{2}$/.test(String(year || ""))) {
            return null;
        }
        segments.push(String(year));
    } else if (year) {
        return null;
    }

    segments.push(safeName);
    return segments.join("/");
}

async function startUpload(database, { targetPath, size, fileName }) {
    const uploadId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + UPLOAD_EXPIRY_MS);
    await database.collection("document_upload_sessions").insertOne({
        _id: uploadId,
        targetPath,
        expectedSize: size,
        fileName,
        createdAt: new Date(),
        expiresAt
    });
    return {
        uploadId,
        chunkSize: UPLOAD_CHUNK_BYTES,
        chunkCount: Math.ceil(size / UPLOAD_CHUNK_BYTES)
    };
}

async function saveUploadChunk(database, { uploadId, index, data }) {
    const session = await database.collection("document_upload_sessions").findOne({
        _id: uploadId,
        expiresAt: { $gt: new Date() }
    });
    if (!session) {
        return { status: "missing" };
    }

    const expectedChunkCount = Math.ceil(session.expectedSize / UPLOAD_CHUNK_BYTES);
    if (!Number.isSafeInteger(index) || index < 0 || index >= expectedChunkCount
        || typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        return { status: "invalid" };
    }

    const chunk = Buffer.from(data, "base64");
    const expectedSize = index === expectedChunkCount - 1
        ? session.expectedSize - index * UPLOAD_CHUNK_BYTES
        : UPLOAD_CHUNK_BYTES;
    if (chunk.length !== expectedSize) {
        return { status: "invalid" };
    }

    try {
        await database.collection("document_upload_chunks").insertOne({
            uploadId,
            index,
            data: chunk,
            expiresAt: session.expiresAt
        });
    } catch (error) {
        if (error.code === 11000) {
            return { status: "duplicate" };
        }
        throw error;
    }

    return { status: "saved" };
}

async function finalizeUpload(database, { uploadId, targetPath }) {
    const sessions = database.collection("document_upload_sessions");
    const session = await sessions.findOne({ _id: uploadId, targetPath });
    if (!session) {
        return { status: "missing" };
    }

    const chunkDocuments = await database.collection("document_upload_chunks")
        .find({ uploadId })
        .sort({ index: 1 })
        .toArray();
    const chunkCount = Math.ceil(session.expectedSize / UPLOAD_CHUNK_BYTES);
    if (chunkDocuments.length !== chunkCount
        || chunkDocuments.some((chunk, index) => chunk.index !== index)) {
        return { status: "incomplete" };
    }

    const pdf = Buffer.concat(chunkDocuments.map((chunk) => chunk.data));
    if (pdf.length !== session.expectedSize || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
        await cancelUpload(database, uploadId);
        return { status: "invalid-pdf" };
    }

    const bucket = new GridFSBucket(database);
    const uploadStream = bucket.openUploadStream(session.fileName, {
        contentType: "application/pdf",
        metadata: { path: targetPath }
    });
    await pipeline(Readable.from([pdf]), uploadStream);

    try {
        const previousFiles = await database.collection("fs.files")
            .find({ "metadata.path": targetPath, _id: { $ne: uploadStream.id } })
            .project({ _id: 1 })
            .toArray();
        for (const file of previousFiles) {
            await bucket.delete(file._id);
        }
    } catch (error) {
        console.error("Unable to remove a replaced MongoDB document:", error);
    }

    try {
        await cancelUpload(database, uploadId);
    } catch (error) {
        console.error("Unable to clean up completed MongoDB upload chunks:", error);
    }
    return { status: "complete", path: targetPath };
}

async function cancelUpload(database, uploadId) {
    await Promise.all([
        database.collection("document_upload_sessions").deleteOne({ _id: uploadId }),
        database.collection("document_upload_chunks").deleteMany({ uploadId })
    ]);
}

module.exports = {
    MAX_UPLOAD_BYTES,
    UPLOAD_CATEGORIES,
    UPLOAD_CHUNK_BYTES,
    cancelUpload,
    createNewDocumentPath,
    finalizeUpload,
    getStorageConfiguration,
    getStorageDatabase,
    getStoredDocument,
    isDocumentPath,
    listStoredDocuments,
    safePdfName,
    saveUploadChunk,
    startUpload
};
