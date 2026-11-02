const fs = require("node:fs/promises");
const path = require("node:path");

const DOCUMENT_ROOT = path.resolve(__dirname, "..", "private-documents");

async function listLocalDocuments(directory = DOCUMENT_ROOT, relativeDirectory = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const documents = [];

    for (const entry of entries) {
        const relativePath = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            documents.push(...await listLocalDocuments(fullPath, relativePath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
            documents.push(relativePath);
        }
    }

    return documents;
}

module.exports = { DOCUMENT_ROOT, listLocalDocuments };
