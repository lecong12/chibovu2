const {
    constantTimeEqual,
    createSessionCookie,
    createSessionToken,
    getAuthConfiguration
} = require("../lib/auth");

module.exports = function login(request, response) {
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return response.status(405).json({ error: "Method not allowed" });
    }

    const config = getAuthConfiguration();
    if (!config) {
        console.error("Authentication environment variables are missing or invalid.");
        return response.status(503).json({ error: "Authentication is not configured" });
    }

    const body = request.body;
    if (!body || typeof body !== "object"
        || typeof body.username !== "string"
        || typeof body.password !== "string") {
        return response.status(400).json({ error: "Invalid request" });
    }

    if (!constantTimeEqual(body.username, config.username)
        || !constantTimeEqual(body.password, config.password)) {
        return response.status(401).json({ error: "Invalid credentials" });
    }

    response.setHeader("Set-Cookie", createSessionCookie(createSessionToken(config.secret)));
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ authenticated: true });
};
