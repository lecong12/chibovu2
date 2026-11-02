const crypto = require("node:crypto");
const {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
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

function getStorageConfiguration() {
    const bucket = process.env.S3_BUCKET;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

    if (!bucket || !accessKeyId || !secretAccessKey) {
        return null;
    }

    const endpoint = process.env.S3_ENDPOINT || undefined;
    return {
        bucket,
        endpoint,
        region: process.env.S3_REGION || (endpoint ? "auto" : "us-east-1"),
        accessKeyId,
        secretAccessKey
    };
}

function createStorageClient(configuration) {
    return new S3Client({
        region: configuration.region,
        endpoint: configuration.endpoint,
        forcePathStyle: Boolean(configuration.endpoint),
        credentials: {
            accessKeyId: configuration.accessKeyId,
            secretAccessKey: configuration.secretAccessKey
        }
    });
}

function isDocumentPath(value) {
    return typeof value === "string" && DOCUMENT_PATH_PATTERN.test(value);
}

async function listStoredDocuments(client, bucket) {
    const documents = [];
    let continuationToken;

    do {
        const result = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken
        }));

        for (const object of result.Contents || []) {
            if (isDocumentPath(object.Key) && !object.Key.startsWith("pending/")) {
                documents.push({
                    path: object.Key,
                    size: object.Size,
                    lastModified: object.LastModified
                });
            }
        }

        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return documents;
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

async function createPresignedUpload(client, bucket, key, size) {
    const uploadId = crypto.randomUUID();
    const pendingKey = `pending/${uploadId}.pdf`;
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: pendingKey,
        ContentType: "application/pdf",
        ContentLength: size,
        Metadata: {
            "target-path": key,
            "expected-size": String(size)
        }
    });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });

    return {
        pendingKey,
        uploadUrl,
        uploadHeaders: {
            "Content-Type": "application/pdf",
            "x-amz-meta-target-path": key,
            "x-amz-meta-expected-size": String(size)
        }
    };
}

function copySource(bucket, key) {
    return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function finalizePresignedUpload(client, bucket, pendingKey, expectedKey) {
    const metadata = await client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: pendingKey
    }));

    if (metadata.ContentType !== "application/pdf"
        || metadata.Metadata?.["target-path"] !== expectedKey
        || metadata.ContentLength !== Number(metadata.Metadata?.["expected-size"])
        || metadata.ContentLength > MAX_UPLOAD_BYTES) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: pendingKey }));
        return { valid: false };
    }

    const sample = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: pendingKey,
        Range: "bytes=0-4"
    }));
    const signature = Buffer.from(await sample.Body.transformToByteArray());
    if (signature.toString("ascii") !== "%PDF-") {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: pendingKey }));
        return { valid: false };
    }

    await client.send(new CopyObjectCommand({
        Bucket: bucket,
        CopySource: copySource(bucket, pendingKey),
        Key: expectedKey,
        ContentType: "application/pdf",
        ContentDisposition: `inline; filename="${expectedKey.split("/").pop()}"`,
        MetadataDirective: "REPLACE",
        Metadata: { "uploaded-via": "web" }
    }));

    try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: pendingKey }));
    } catch (error) {
        console.error("Unable to remove a completed upload's temporary object:", error);
    }

    return { valid: true };
}

module.exports = {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    MAX_UPLOAD_BYTES,
    UPLOAD_CATEGORIES,
    createNewDocumentPath,
    createPresignedUpload,
    createStorageClient,
    finalizePresignedUpload,
    getStorageConfiguration,
    isDocumentPath,
    listStoredDocuments
};
