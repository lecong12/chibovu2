const fs = require("node:fs/promises");
const path = require("node:path");
const { getAuthConfiguration, isAuthenticated } = require("../lib/auth");

const DOCUMENT_ROOT = path.resolve(__dirname, "..", "private-documents");
const DOCUMENT_PATH_PATTERN = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.pdf$/;

async function listDocuments(directory, relativeDirectory = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const documents = [];

    for (const entry of entries) {
        const relativePath = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            documents.push(...await listDocuments(fullPath, relativePath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
            documents.push(relativePath);
        }
    }

    return documents;
}

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
            const availableDocuments = await listDocuments(DOCUMENT_ROOT);
            return response.status(200).json(availableDocuments);
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

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Length", document.length);
    response.setHeader("Content-Disposition", `inline; filename="${path.basename(relativePath)}"`);
    if (request.method === "HEAD") {
        return response.status(200).end();
    }
    return response.status(200).send(document);
};
