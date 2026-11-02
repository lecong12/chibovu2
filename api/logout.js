const { clearSessionCookie } = require("../lib/auth");

module.exports = function logout(request, response) {
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return response.status(405).json({ error: "Method not allowed" });
    }

    response.setHeader("Set-Cookie", clearSessionCookie());
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ authenticated: false });
};
