const { getAuthConfiguration, isAuthenticated } = require("../lib/auth");
const { listLocalDocuments } = require("../lib/document-files");
const {
    MAX_UPLOAD_BYTES,
    UPLOAD_CATEGORIES,
    DeleteObjectCommand,
    createNewDocumentPath,
    createPresignedUpload,
    createStorageClient,
    finalizePresignedUpload,
    getStorageConfiguration,
    isDocumentPath,
    listStoredDocuments
} = require("../lib/storage");

const PENDING_KEY_PATTERN = /^pending\/[a-f0-9-]{36}\.pdf$/;

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

    const client = createStorageClient(storageConfiguration);
    try {
        if (request.method === "GET") {
            const documents = await listStoredDocuments(client, storageConfiguration.bucket);
            return response.status(200).json(documents);
        }

        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return response.status(400).json({ error: "Invalid request" });
        }

        if (body.action === "start") {
            return await startUpload(body, client, storageConfiguration.bucket, response);
        }
        if (body.action === "complete") {
            return await completeUpload(body, client, storageConfiguration.bucket, response);
        }
        if (body.action === "cancel") {
            if (typeof body.pendingKey !== "string" || !PENDING_KEY_PATTERN.test(body.pendingKey)) {
                return response.status(400).json({ error: "Invalid upload cancellation" });
            }
            await client.send(new DeleteObjectCommand({
                Bucket: storageConfiguration.bucket,
                Key: body.pendingKey
            }));
            return response.status(200).json({ cancelled: true });
        }

        return response.status(400).json({ error: "Invalid upload action" });
    } catch (error) {
        console.error("Unable to process document upload:", error);
        return response.status(500).json({ error: "Unable to process document upload" });
    }
};

async function startUpload(body, client, bucket, response) {
    if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_UPLOAD_BYTES) {
        return response.status(400).json({ error: "PDF files must be between 1 byte and 25 MB" });
    }

    let targetPath;
    if (body.mode === "replace") {
        if (!isDocumentPath(body.replacePath)) {
            return response.status(400).json({ error: "Invalid document path" });
        }
        const [localDocuments, storedDocuments] = await Promise.all([
            listLocalDocuments(),
            listStoredDocuments(client, bucket)
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
            listStoredDocuments(client, bucket)
        ]);
        const existing = new Set([...localDocuments, ...storedDocuments.map((document) => document.path)]);
        const pathParts = targetPath.split("/");
        const fileName = pathParts.pop();
        const directory = pathParts.join("/");
        let candidate = targetPath;
        let suffix = 2;
        while (existing.has(candidate)) {
            const extension = ".pdf";
            candidate = `${directory}/${fileName.slice(0, -extension.length)}-${suffix}${extension}`;
            suffix += 1;
        }
        targetPath = candidate;
    } else {
        return response.status(400).json({ error: "Invalid upload mode" });
    }

    const signedUpload = await createPresignedUpload(client, bucket, targetPath, body.size);
    return response.status(200).json({ ...signedUpload, targetPath });
}

async function completeUpload(body, client, bucket, response) {
    if (typeof body.pendingKey !== "string" || !PENDING_KEY_PATTERN.test(body.pendingKey)
        || !isDocumentPath(body.targetPath)) {
        return response.status(400).json({ error: "Invalid upload confirmation" });
    }

    const isManagedUpload = isManagedUploadPath(body.targetPath);
    if (!isManagedUpload) {
        const [localDocuments, storedDocuments] = await Promise.all([
            listLocalDocuments(),
            listStoredDocuments(client, bucket)
        ]);
        const existing = new Set([...localDocuments, ...storedDocuments.map((document) => document.path)]);
        if (!existing.has(body.targetPath)) {
            return response.status(400).json({ error: "Invalid replacement document" });
        }
    }

    const result = await finalizePresignedUpload(client, bucket, body.pendingKey, body.targetPath);
    if (!result.valid) {
        return response.status(400).json({ error: "The uploaded file is not a valid PDF" });
    }

    return response.status(200).json({ path: body.targetPath });
}

function isManagedUploadPath(documentPath) {
    const segments = documentPath.split("/");
    if (segments[0] !== "uploads" || !UPLOAD_CATEGORIES.has(segments[1])) {
        return false;
    }

    if (segments[1] === "bao-cao") {
        return segments.length === 4 && /^(?:19|20|21)\d{2}$/.test(segments[2]);
    }
    return segments.length === 3;
}
