"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.issueAccessToken = issueAccessToken;
exports.verifyAccessToken = verifyAccessToken;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_error_1 = require("../errors/app-error");
function jwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
        throw new app_error_1.AppError(503, "AUTH_NOT_CONFIGURED", "JWT_SECRET must contain at least 32 bytes");
    }
    return secret;
}
async function hashPassword(password) {
    return bcryptjs_1.default.hash(password, 12);
}
async function verifyPassword(password, hash) {
    return bcryptjs_1.default.compare(password, hash);
}
function issueAccessToken(userId, sessionId, fingerprint) {
    return jsonwebtoken_1.default.sign({ device: fingerprint }, jwtSecret(), {
        subject: userId, jwtid: sessionId, expiresIn: "1h", issuer: "instanta-api", audience: "instanta-web",
        algorithm: "HS256",
    });
}
function verifyAccessToken(token) {
    try {
        const payload = jsonwebtoken_1.default.verify(token, jwtSecret(), { issuer: "instanta-api", audience: "instanta-web", algorithms: ["HS256"] });
        if (typeof payload === "string" || !payload.sub || !payload.jti || typeof payload.device !== "string") {
            throw new Error("Invalid token subject");
        }
        return { userId: payload.sub, sessionId: payload.jti, device: payload.device };
    }
    catch {
        throw new app_error_1.AppError(401, "UNAUTHORIZED", "Bearer token is invalid or expired");
    }
}
