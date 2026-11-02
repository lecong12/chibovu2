const { getAuthConfiguration, isAuthenticated } = require("../lib/auth");

module.exports = function session(request, response) {
    if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return response.status(405).json({ error: "Method not allowed" });
    }

    const config = getAuthConfiguration();
    if (!config) {
        console.error("Authentication environment variables are missing or invalid.");
        return response.status(503).json({ error: "Authentication is not configured" });
    }

    response.setHeader("Cache-Control", "no-store");
    if (!isAuthenticated(request, config.secret)) {
        return response.status(401).json({ authenticated: false });
    }

    return response.status(200).json({ authenticated: true });
};
