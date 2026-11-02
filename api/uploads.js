const { getAuthConfiguration, isAuthenticated } = require("../lib/auth");
const { listLocalDocuments } = require("../lib/document-files");
const {
    MAX_UPLOAD_BYTES,
    UPLOAD_CATEGORIES,
    cancelUpload,
    createNewDocumentPath,
    finalizeUpload,
    getStorageConfiguration,
    getStorageDatabase,
    isDocumentPath,
    listStoredDocuments,
    safePdfName,
    saveUploadChunk,
    startUpload
} = require("../lib/storage");

const UPLOAD_ID_PATTERN = /^[a-f0-9-]{36}$/;

module.exports = async function uploads(request, response) {
    if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        return response.status(405).json({ error: "Method not allowed" });
    }

    const authConfiguration = getAuthConfiguration();
    if (!authConfiguration) {
        console.error("Authentication environment variables are missing or invalid.");
        return response.status(503).json({ error: "Authentication is not configured" });
    }

    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!isAuthenticated(request, authConfiguration.secret)) {
        return response.status(401).json({ error: "Authentication required" });
    }
    if (request.method === "POST"
        && !/^application\/json(?:\s*;|$)/i.test(request.headers?.["content-type"] || "")) {
        return response.status(415).json({ error: "Content-Type must be application/json" });
    }

    const storageConfiguration = getStorageConfiguration();
    if (!storageConfiguration) {
        return response.status(503).json({ error: "Persistent storage is not configured" });
    }

    let database;
    try {
        database = await getStorageDatabase(storageConfiguration);
    } catch (error) {
        console.error("Unable to connect to MongoDB for document uploads:", error);
        return response.status(503).json({
            error: "Cannot connect to MongoDB. Check the connection string, database name, and Atlas Network Access."
        });
    }

    try {
        if (request.method === "GET") {
            return response.status(200).json(await listStoredDocuments(database));
        }

        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return response.status(400).json({ error: "Invalid request" });
        }

        if (body.action === "start") {
            return await startDocumentUpload(body, database, response);
        }
        if (body.action === "chunk") {
            if (!UPLOAD_ID_PATTERN.test(body.uploadId || "")) {
                return response.status(400).json({ error: "Invalid upload session" });
            }
            const result = await saveUploadChunk(database, body);
            if (result.status === "missing") {
                return response.status(404).json({ error: "Upload session expired" });
            }
            if (result.status === "duplicate") {
                return response.status(409).json({ error: "This upload part was already received" });
            }
            if (result.status !== "saved") {
                return response.status(400).json({ error: "Invalid upload part" });
            }
            return response.status(200).json({ uploaded: true });
        }
        if (body.action === "complete") {
            if (!UPLOAD_ID_PATTERN.test(body.uploadId || "") || !isDocumentPath(body.targetPath)) {
                return response.status(400).json({ error: "Invalid upload confirmation" });
            }
            const result = await finalizeUpload(database, body);
            if (result.status === "missing") {
                return response.status(404).json({ error: "Upload session expired" });
            }
            if (result.status === "incomplete") {
                return response.status(400).json({ error: "Some upload parts are missing" });
            }
            if (result.status === "invalid-pdf") {
                return response.status(400).json({ error: "The uploaded file is not a valid PDF" });
            }
            return response.status(200).json({ path: result.path });
        }
        if (body.action === "cancel") {
            if (!UPLOAD_ID_PATTERN.test(body.uploadId || "")) {
                return response.status(400).json({ error: "Invalid upload session" });
            }
            await cancelUpload(database, body.uploadId);
            return response.status(200).json({ cancelled: true });
        }

        return response.status(400).json({ error: "Invalid upload action" });
    } catch (error) {
        console.error("Unable to process MongoDB document upload:", error);
        return response.status(500).json({ error: "Unable to process document upload" });
    }
};

async function startDocumentUpload(body, database, response) {
    if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_UPLOAD_BYTES) {
        return response.status(400).json({ error: "PDF files must be between 1 byte and 25 MB" });
    }
    if (!safePdfName(body.fileName)) {
        return response.status(400).json({ error: "Only PDF files can be uploaded" });
    }

    let targetPath;
    if (body.mode === "replace") {
        if (!isDocumentPath(body.replacePath)) {
            return response.status(400).json({ error: "Invalid document path" });
        }
        const [localDocuments, storedDocuments] = await Promise.all([
            listLocalDocuments(),
            listStoredDocuments(database)
        ]);
        if (!new Set([...localDocuments, ...storedDocuments.map((document) => document.path)])
            .has(body.replacePath)) {
            return response.status(404).json({ error: "Document to replace was not found" });
        }
        targetPath = body.replacePath;
    } else if (body.mode === "new") {
        targetPath = createNewDocumentPath({
            fileName: body.fileName,
            category: body.category,
            year: body.year
        });
        if (!targetPath) {
            return response.status(400).json({ error: "Invalid document name or category" });
        }

        const [localDocuments, storedDocuments] = await Promise.all([
            listLocalDocuments(),
            listStoredDocuments(database)
        ]);
        const existing = new Set([...localDocuments, ...storedDocuments.map((document) => document.path)]);
        const pathParts = targetPath.split("/");
        const fileName = pathParts.pop();
        const directory = pathParts.join("/");
        let candidate = targetPath;
        let suffix = 2;
        while (existing.has(candidate)) {
            candidate = `${directory}/${fileName.slice(0, -4)}-${suffix}.pdf`;
            suffix += 1;
        }
        targetPath = candidate;
    } else {
        return response.status(400).json({ error: "Invalid upload mode" });
    }

    const upload = await startUpload(database, {
        targetPath,
        size: body.size,
        fileName: safePdfName(body.fileName)
    });
    return response.status(200).json({ ...upload, targetPath });
}
