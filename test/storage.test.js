const assert = require("node:assert/strict");
const test = require("node:test");
const {
    finalizePresignedUpload
} = require("../lib/storage");

test("finalizing a signed PDF upload verifies it and copies it into the document path", async () => {
    const sentCommands = [];
    const client = {
        async send(command) {
            sentCommands.push(command);
            switch (command.constructor.name) {
                case "HeadObjectCommand":
                    return {
                        ContentType: "application/pdf",
                        ContentLength: 5,
                        Metadata: {
                            "target-path": "uploads/tai-lieu-chung/test.pdf",
                            "expected-size": "5"
                        }
                    };
                case "GetObjectCommand":
                    return { Body: { transformToByteArray: async () => Buffer.from("%PDF-") } };
                default:
                    return {};
            }
        }
    };

    const result = await finalizePresignedUpload(
        client,
        "private-documents",
        "pending/01234567-89ab-cdef-0123-456789abcdef.pdf",
        "uploads/tai-lieu-chung/test.pdf"
    );

    assert.deepEqual(result, { valid: true });
    assert.deepEqual(sentCommands.map((command) => command.constructor.name), [
        "HeadObjectCommand",
        "GetObjectCommand",
        "CopyObjectCommand",
        "DeleteObjectCommand"
    ]);
    assert.equal(sentCommands[2].input.Key, "uploads/tai-lieu-chung/test.pdf");
});

test("finalizing an upload rejects content that is not a PDF", async () => {
    const sentCommands = [];
    const client = {
        async send(command) {
            sentCommands.push(command);
            if (command.constructor.name === "HeadObjectCommand") {
                return {
                    ContentType: "application/pdf",
                    ContentLength: 4,
                    Metadata: {
                        "target-path": "uploads/tai-lieu-chung/test.pdf",
                        "expected-size": "4"
                    }
                };
            }
            if (command.constructor.name === "GetObjectCommand") {
                return { Body: { transformToByteArray: async () => Buffer.from("nope!") } };
            }
            return {};
        }
    };

    const result = await finalizePresignedUpload(
        client,
        "private-documents",
        "pending/01234567-89ab-cdef-0123-456789abcdef.pdf",
        "uploads/tai-lieu-chung/test.pdf"
    );

    assert.deepEqual(result, { valid: false });
    assert.deepEqual(sentCommands.map((command) => command.constructor.name), [
        "HeadObjectCommand",
        "GetObjectCommand",
        "DeleteObjectCommand"
    ]);
});
