"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.secureHash = secureHash;
exports.deviceHash = deviceHash;
exports.deviceFingerprint = deviceFingerprint;
exports.enforceRateLimit = enforceRateLimit;
exports.beginChallenge = beginChallenge;
exports.completeChallenge = completeChallenge;
const node_crypto_1 = require("node:crypto");
const prisma_1 = require("../config/prisma");
const app_error_1 = require("../errors/app-error");
const transaction_service_1 = require("./transaction.service");
const jobs_service_1 = require("./jobs.service");
const pii_service_1 = require("./pii.service");
const auth_service_1 = require("./auth.service");
const demo_1 = require("../config/demo");
function secureHash(value) {
    const key = process.env.JWT_SECRET;
    if (!key || key.length < 32)
        throw new app_error_1.AppError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured");
    return (0, node_crypto_1.createHmac)("sha256", key).update(value).digest("hex");
}
function deviceHash(request) {
    return deviceFingerprint(request.header("x-device-id"), request.ip ?? request.socket.remoteAddress ?? "unknown");
}
function deviceFingerprint(id, ip) {
    if (!id || !/^[a-zA-Z0-9_-]{20,128}$/.test(id)) {
        throw new app_error_1.AppError(400, "DEVICE_ID_REQUIRED", "We couldn't recognize this device. Refresh the page and try again.");
    }
    // Express trust proxy stays disabled: never trust caller-supplied X-Forwarded-For.
    return secureHash(`${id}\0${ip}`);
}
async function enforceRateLimit(key, limit, windowSeconds, message = "Too many authentication attempts. Try again later.") {
    const rows = await prisma_1.prisma.$queryRaw `
    INSERT INTO "RateLimitBucket" (key, count, "expiresAt")
    VALUES (${secureHash(key)}, 1, clock_timestamp() + make_interval(secs => ${windowSeconds}))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "RateLimitBucket"."expiresAt" <= clock_timestamp() THEN 1 ELSE "RateLimitBucket".count + 1 END,
      "expiresAt" = CASE WHEN "RateLimitBucket"."expiresAt" <= clock_timestamp()
        THEN clock_timestamp() + make_interval(secs => ${windowSeconds}) ELSE "RateLimitBucket"."expiresAt" END
    RETURNING count
  `;
    if ((rows[0]?.count ?? limit + 1) > limit)
        throw new app_error_1.AppError(429, "RATE_LIMITED", message);
}
async function beginChallenge(userId, fingerprint, credentialVersion) {
    await enforceRateLimit(`otp-user:${userId}`, 5, 900);
    return (0, transaction_service_1.serializable)(async (tx) => {
        await tx.$queryRaw `SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        if (user.isDemo !== (0, demo_1.isDemoMode)() || (credentialVersion !== undefined && user.credentialVersion !== credentialVersion)) {
            throw new app_error_1.AppError(401, "SIGN_IN_AGAIN", "Your account changed. Please sign in again.");
        }
        if (!user.phoneEncrypted)
            throw new app_error_1.AppError(409, "PHONE_ENROLLMENT_REQUIRED", "This account needs a registered phone. Contact support for identity-verified enrollment.");
        const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
        if (!clock)
            throw new Error("Database clock unavailable");
        const { now } = clock;
        if (user.recoveryLockedUntil && user.recoveryLockedUntil > now)
            throw new app_error_1.AppError(429, "ACCOUNT_TEMPORARILY_LOCKED", "Your account is temporarily locked after three wrong recovery codes. Please wait one hour.");
        const id = (0, node_crypto_1.randomUUID)();
        const code = (0, node_crypto_1.randomInt)(0, 1_000_000).toString().padStart(6, "0");
        await tx.authChallenge.create({
            data: { id, userId, credentialVersion: user.credentialVersion, deviceHash: fingerprint, codeHash: secureHash(`${id}:${code}`),
                expiresAt: new Date(now.getTime() + 300_000) },
        });
        await (0, jobs_service_1.enqueue)(tx, "OTP", `otp:${id}`, { userId, challengeId: id, encryptedCode: (0, pii_service_1.encryptPii)(code) });
        await tx.auditEvent.create({ data: { actorId: userId, subjectId: userId, action: "MFA_CHALLENGE_CREATED" } });
        return { challengeId: id, mfaRequired: true, expiresIn: 300 };
    });
}
async function completeChallenge(id, code, fingerprint) {
    const outcome = await (0, transaction_service_1.serializable)(async (tx) => {
        const found = await tx.authChallenge.findUnique({ where: { id } });
        if (!found)
            return null;
        await tx.$queryRaw `SELECT id FROM "User" WHERE id = ${found.userId} FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: found.userId } });
        await tx.$queryRaw `SELECT id FROM "AuthChallenge" WHERE id = ${id} FOR UPDATE`;
        const challenge = await tx.authChallenge.findUnique({ where: { id } });
        const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
        if (!challenge || !clock || challenge.expiresAt <= clock.now || challenge.consumedAt || challenge.attempts >= 5
            || challenge.deviceHash !== fingerprint || challenge.credentialVersion !== user.credentialVersion || user.isDemo !== (0, demo_1.isDemoMode)()
            || (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now))
            return null;
        if (challenge.codeHash !== secureHash(`${id}:${code}`)) {
            // Persist bad-attempt counters: throwing inside the transaction would roll them back.
            await tx.authChallenge.update({ where: { id }, data: { attempts: { increment: 1 } } });
            return null;
        }
        await tx.authChallenge.update({ where: { id }, data: { consumedAt: clock.now } });
        const session = await tx.authSession.create({
            data: { userId: challenge.userId, deviceHash: fingerprint, expiresAt: new Date(clock.now.getTime() + 3_600_000) },
        });
        await tx.auditEvent.create({ data: { actorId: challenge.userId, subjectId: challenge.userId, action: "MFA_SESSION_CREATED" } });
        return { userId: challenge.userId, sessionId: session.id };
    });
    if (!outcome)
        throw new app_error_1.AppError(401, "INVALID_OTP", "That code cannot be used. Check it and try again on the device where you requested it, or request a new code.");
    return {
        accessToken: (0, auth_service_1.issueAccessToken)(outcome.userId, outcome.sessionId, fingerprint),
        tokenType: "Bearer", expiresIn: 3600,
    };
}
