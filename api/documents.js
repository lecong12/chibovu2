const fs = require("node:fs/promises");
const path = require("node:path");
const { getAuthConfiguration, isAuthenticated } = require("../lib/auth");
const { DOCUMENT_ROOT, listLocalDocuments } = require("../lib/document-files");
const {
    getStorageConfiguration,
    getStorageDatabase,
    getStoredDocument,
    listStoredDocuments
} = require("../lib/storage");

const DOCUMENT_PATH_PATTERN = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.pdf$/;

module.exports = async function documents(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        return response.status(405).json({ error: "Method not allowed" });
    }

    const config = getAuthConfiguration();
    if (!config) {
        console.error("Authentication environment variables are missing or invalid.");
        return response.status(503).json({ error: "Authentication is not configured" });
    }

    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!isAuthenticated(request, config.secret)) {
        return response.status(401).json({ error: "Authentication required" });
    }

    const query = request.query || {};
    if (query.list === "1") {
        try {
            const availableDocuments = await listLocalDocuments();
            const storageConfiguration = getStorageConfiguration();
            if (storageConfiguration) {
                const database = await getStorageDatabase(storageConfiguration);
                const storedDocuments = await listStoredDocuments(database);
                availableDocuments.push(...storedDocuments.map((document) => document.path));
            }
            return response.status(200).json([...new Set(availableDocuments)].sort());
        } catch (error) {
            console.error("Unable to list private documents:", error);
            return response.status(500).json({ error: "Unable to list documents" });
        }
    }

    const relativePath = query.path;
    if (typeof relativePath !== "string" || !DOCUMENT_PATH_PATTERN.test(relativePath)) {
        return response.status(400).json({ error: "Invalid document path" });
    }

    const documentPath = path.resolve(DOCUMENT_ROOT, ...relativePath.split("/"));
    if (!documentPath.startsWith(`${DOCUMENT_ROOT}${path.sep}`)) {
        return response.status(400).json({ error: "Invalid document path" });
    }

    const storageConfiguration = getStorageConfiguration();
    if (storageConfiguration) {
        try {
            const database = await getStorageDatabase(storageConfiguration);
            const storedDocument = await getStoredDocument(database, relativePath);
            if (storedDocument) {
                setDocumentHeaders(response, relativePath, storedDocument.size);
                if (request.method === "HEAD") {
                    return response.status(200).end();
                }
                return response.status(200).send(storedDocument.body);
            }
        } catch (error) {
            console.error("Unable to read document from MongoDB:", error);
            return response.status(500).json({ error: "Unable to read document" });
        }
    }

    let document;
    try {
        document = await fs.readFile(documentPath);
    } catch (error) {
        if (error.code === "ENOENT") {
            return response.status(404).json({ error: "Document not found" });
        }
        console.error("Unable to read private document:", error);
        return response.status(500).json({ error: "Unable to read document" });
    }

    setDocumentHeaders(response, relativePath, document.length);
    if (request.method === "HEAD") {
        return response.status(200).end();
    }
    return response.status(200).send(document);
};

function setDocumentHeaders(response, relativePath, size) {
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Length", size);
    response.setHeader("Content-Disposition", `inline; filename="${path.basename(relativePath)}"`);
}
