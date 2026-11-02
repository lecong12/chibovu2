const crypto = require("node:crypto");

const SESSION_COOKIE = "v2_session";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

function getAuthConfiguration() {
    const username = process.env.AUTH_USERNAME;
    const password = process.env.AUTH_PASSWORD;
    const secret = process.env.SESSION_SECRET;

    if (!username || !password || !secret || Buffer.byteLength(secret) < 32) {
        return null;
    }

    return { username, password, secret };
}

function constantTimeEqual(left, right) {
    const leftHash = crypto.createHash("sha256").update(String(left)).digest();
    const rightHash = crypto.createHash("sha256").update(String(right)).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

function createSessionToken(secret) {
    const payload = Buffer.from(JSON.stringify({
        version: 1,
        expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000
    })).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}.${signature}`;
}

function isAuthenticated(request, secret) {
    const cookies = (request.headers && request.headers.cookie) || "";
    const cookie = cookies.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${SESSION_COOKIE}=`));

    if (!cookie) {
        return false;
    }

    const token = cookie.slice(SESSION_COOKIE.length + 1);
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || !/^[a-f0-9]{64}$/.test(signature)) {
        return false;
    }

    const expectedSignature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    if (!constantTimeEqual(signature, expectedSignature)) {
        return false;
    }

    let session;
    try {
        session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch (error) {
        if (error instanceof SyntaxError) {
            return false;
        }
        throw error;
    }

    return session.version === 1
        && Number.isSafeInteger(session.expiresAt)
        && session.expiresAt > Date.now();
}

function createSessionCookie(token) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION_SECONDS}`;
}

function clearSessionCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

module.exports = {
    clearSessionCookie,
    constantTimeEqual,
    createSessionCookie,
    createSessionToken,
    getAuthConfiguration,
    isAuthenticated,
    SESSION_COOKIE
};
