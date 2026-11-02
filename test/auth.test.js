const assert = require("node:assert/strict");
const test = require("node:test");
const login = require("../api/login");
const documents = require("../api/documents");
const { createSessionToken } = require("../lib/auth");

function createResponse() {
    return {
        headers: {},
        statusCode: 200,
        body: undefined,
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(value) {
            this.body = value;
            return this;
        },
        send(value) {
            this.body = value;
            return this;
        },
        end() {
            return this;
        }
    };
}

function withAuthEnvironment(callback) {
    const previous = {
        AUTH_USERNAME: process.env.AUTH_USERNAME,
        AUTH_PASSWORD: process.env.AUTH_PASSWORD,
        SESSION_SECRET: process.env.SESSION_SECRET
    };
    process.env.AUTH_USERNAME = "test-user";
    process.env.AUTH_PASSWORD = "test-password";
    process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-bytes";

    return Promise.resolve()
        .then(callback)
        .finally(() => {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        });
}

test("login issues an authenticated, HttpOnly session cookie", () => withAuthEnvironment(async () => {
    const response = createResponse();
    await login({
        method: "POST",
        body: { username: "test-user", password: "test-password" }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["Set-Cookie"], /HttpOnly/);
    assert.match(response.headers["Set-Cookie"], /Secure/);
    assert.match(response.headers["Set-Cookie"], /SameSite=Strict/);
}));

test("login rejects invalid credentials", () => withAuthEnvironment(async () => {
    const response = createResponse();
    await login({
        method: "POST",
        body: { username: "test-user", password: "wrong-password" }
    }, response);

    assert.equal(response.statusCode, 401);
}));

test("document listing requires a valid session and exposes only available PDFs", () => withAuthEnvironment(async () => {
    const unauthenticatedResponse = createResponse();
    await documents({
        method: "GET",
        headers: {},
        query: { list: "1" }
    }, unauthenticatedResponse);
    assert.equal(unauthenticatedResponse.statusCode, 401);

    const token = createSessionToken(process.env.SESSION_SECRET);
    const response = createResponse();
    await documents({
        method: "GET",
        headers: { cookie: `v2_session=${token}` },
        query: { list: "1" }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes("bao_cao_chinh_tri.pdf"));
    assert.ok(response.body.includes("2026/bc_thang1.pdf"));
    assert.ok(!response.body.some((document) => document.includes("note.txt")));
}));

test("document endpoint rejects traversal and does not expose missing files", () => withAuthEnvironment(async () => {
    const token = createSessionToken(process.env.SESSION_SECRET);
    const request = (path) => ({
        method: "GET",
        headers: { cookie: `v2_session=${token}` },
        query: { path }
    });

    const traversalResponse = createResponse();
    await documents(request("../README.md"), traversalResponse);
    assert.equal(traversalResponse.statusCode, 400);

    const missingResponse = createResponse();
    await documents(request("2027/missing.pdf"), missingResponse);
    assert.equal(missingResponse.statusCode, 404);
}));

test("document endpoint serves PDFs only to an authenticated session", () => withAuthEnvironment(async () => {
    const token = createSessionToken(process.env.SESSION_SECRET);
    const response = createResponse();
    await documents({
        method: "GET",
        headers: { cookie: `v2_session=${token}` },
        query: { path: "bao_cao_chinh_tri.pdf" }
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["Content-Type"], "application/pdf");
    assert.equal(response.headers["Cache-Control"], "private, no-store");
    assert.ok(Buffer.isBuffer(response.body));
    assert.ok(response.body.length > 0);
}));
