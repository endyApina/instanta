"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.authenticateSession = authenticateSession;
const app_error_1 = require("../errors/app-error");
const auth_service_1 = require("../services/auth.service");
const prisma_1 = require("../config/prisma");
const session_service_1 = require("../services/session.service");
const demo_1 = require("../config/demo");
async function requireAuth(request, _response, next) {
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
        next(new app_error_1.AppError(401, "UNAUTHORIZED", "Please sign in to continue."));
        return;
    }
    try {
        const session = await authenticateSession(authorization.slice(7), request.header("x-device-id"), request.ip ?? request.socket.remoteAddress ?? "unknown");
        request.userId = session.userId;
        request.sessionId = session.id;
        next();
    }
    catch (error) {
        next(error);
    }
}
async function authenticateSession(token, deviceId, ip) {
    const claims = (0, auth_service_1.verifyAccessToken)(token);
    const fingerprint = (0, session_service_1.deviceFingerprint)(deviceId, ip);
    if (claims.device !== fingerprint) {
        throw new app_error_1.AppError(401, "MFA_REQUIRED", "You're using a different device or connection. Please sign in again and confirm the code sent to your phone.");
    }
    const session = await prisma_1.prisma.authSession.findUnique({ where: { id: claims.sessionId } });
    if (!session || session.revokedAt || session.userId !== claims.userId || session.deviceHash !== fingerprint || session.expiresAt <= new Date()) {
        throw new app_error_1.AppError(401, "UNAUTHORIZED", "Session expired or revoked. Sign in again.");
    }
    const user = await prisma_1.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.isDemo !== (0, demo_1.isDemoMode)())
        throw new app_error_1.AppError(401, "ACCOUNT_MODE_MISMATCH", "This account belongs to a different environment. Please sign in here.");
    if (user.recoveryLockedUntil && user.recoveryLockedUntil > new Date())
        throw new app_error_1.AppError(401, "ACCOUNT_TEMPORARILY_LOCKED", "Your account is temporarily locked. Please wait one hour before signing in again.");
    return session;
}
