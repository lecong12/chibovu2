const assert = require("node:assert/strict");
const test = require("node:test");
const {
    UPLOAD_CHUNK_BYTES,
    createNewDocumentPath,
    getStorageConfiguration,
    safePdfName,
    saveUploadChunk
} = require("../lib/storage");

test("MongoDB configuration requires both the connection URI and database name", () => {
    const previous = {
        MONGODB_URI: process.env.MONGODB_URI,
        MONGODB_DATABASE: process.env.MONGODB_DATABASE
    };

    try {
        delete process.env.MONGODB_URI;
        delete process.env.MONGODB_DATABASE;
        assert.equal(getStorageConfiguration(), null);

        process.env.MONGODB_URI = "mongodb+srv://example.invalid/";
        assert.equal(getStorageConfiguration(), null);

        process.env.MONGODB_DATABASE = "chibovu2";
        assert.deepEqual(getStorageConfiguration(), {
            uri: "mongodb+srv://example.invalid/",
            database: "chibovu2"
        });
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("upload paths sanitize PDF names and enforce the supported categories", () => {
    assert.equal(safePdfName("Báo cáo tháng 3.pdf"), "Bao-cao-thang-3.pdf");
    assert.equal(safePdfName("../private.pdf"), "private.pdf");
    assert.equal(safePdfName("notes.txt"), null);
    assert.equal(createNewDocumentPath({
        fileName: "Báo cáo tháng 3.pdf",
        category: "bao-cao",
        year: "2026"
    }), "uploads/bao-cao/2026/Bao-cao-thang-3.pdf");
    assert.equal(createNewDocumentPath({
        fileName: "report.pdf",
        category: "unknown"
    }), null);
});

test("upload chunks require an active session and the exact expected chunk size", async () => {
    const inserted = [];
    const database = {
        collection(name) {
            assert.equal(name, "document_upload_sessions");
            return {
                async findOne() {
                    return {
                        expectedSize: UPLOAD_CHUNK_BYTES + 2,
                        expiresAt: new Date(Date.now() + 60_000)
                    };
                }
            };
        }
    };
    const chunkDatabase = {
        ...database,
        collection(name) {
            if (name === "document_upload_sessions") return database.collection(name);
            assert.equal(name, "document_upload_chunks");
            return {
                async insertOne(chunk) {
                    inserted.push(chunk);
                }
            };
        }
    };

    const first = await saveUploadChunk(chunkDatabase, {
        uploadId: "test-upload",
        index: 0,
        data: Buffer.alloc(UPLOAD_CHUNK_BYTES, 0x41).toString("base64")
    });
    const incorrectFinalChunk = await saveUploadChunk(chunkDatabase, {
        uploadId: "test-upload",
        index: 1,
        data: Buffer.alloc(3, 0x41).toString("base64")
    });

    assert.deepEqual(first, { status: "saved" });
    assert.deepEqual(incorrectFinalChunk, { status: "invalid" });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].data.length, UPLOAD_CHUNK_BYTES);
});

test("upload chunks reject duplicate part indexes", async () => {
    const database = {
        collection() {
            return {
                async findOne() {
                    return {
                        expectedSize: 1,
                        expiresAt: new Date(Date.now() + 60_000)
                    };
                },
                async insertOne() {
                    const error = new Error("Duplicate key");
                    error.code = 11000;
                    throw error;
                }
            };
        }
    };

    const result = await saveUploadChunk(database, {
        uploadId: "test-upload",
        index: 0,
        data: Buffer.from("%").toString("base64")
    });
    assert.deepEqual(result, { status: "duplicate" });
});
