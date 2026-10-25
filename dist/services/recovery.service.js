"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recoveryContactSchema = exports.passwordSchema = void 0;
exports.forgotPassword = forgotPassword;
exports.verifyRecoveryOtp = verifyRecoveryOtp;
exports.resetPassword = resetPassword;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const app_error_1 = require("../errors/app-error");
const transaction_service_1 = require("./transaction.service");
const session_service_1 = require("./session.service");
const pii_service_1 = require("./pii.service");
const jobs_service_1 = require("./jobs.service");
const auth_service_1 = require("./auth.service");
const demo_1 = require("../config/demo");
exports.passwordSchema = zod_1.z.string().min(12, "Use at least 12 characters for your password.")
    .max(72, "Use no more than 72 characters.").refine((value) => Buffer.byteLength(value) <= 72, "Your password is too long. Use fewer characters.");
exports.recoveryContactSchema = zod_1.z.string().trim().max(254).refine((value) => zod_1.z.email().safeParse(value).success || /^\+234[789]\d{9}$/.test(value), "Enter your email or Nigerian mobile number, such as +2348012345678.");
function matches(expected, actual) {
    return (0, node_crypto_1.timingSafeEqual)(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
const invalid = () => new app_error_1.AppError(401, "RECOVERY_CODE_INVALID", "That code cannot be used. It may be wrong, expired or already used. After three wrong codes, wait one hour.");
async function forgotPassword(contact, fingerprint) {
    const normalized = contact.toLowerCase();
    await (0, session_service_1.enforceRateLimit)(`recover-contact:${normalized}`, 5, 3600, "Too many reset requests. Please wait an hour before trying again.");
    const id = (0, node_crypto_1.randomUUID)();
    await (0, transaction_service_1.serializable)(async (tx) => {
        const where = normalized.includes("@")
            ? { emailLookupHash: (0, pii_service_1.piiLookupHash)(`email:${normalized}`) }
            : { phoneLookupHash: (0, pii_service_1.piiLookupHash)(`phone:${normalized}`) };
        const found = await tx.user.findUnique({ where });
        if (!found || found.isDemo !== (0, demo_1.isDemoMode)())
            return;
        await tx.$queryRaw `SELECT id FROM "User" WHERE id = ${found.id} FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
        const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
        if (!clock)
            throw new Error("Database clock unavailable");
        if (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now)
            return;
        if (!user.phoneEncrypted)
            return;
        if (user.recoveryLockedUntil)
            await tx.user.update({ where: { id: user.id }, data: { recoveryFailures: 0, recoveryLockedUntil: null } });
        await tx.passwordRecovery.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now, grantHash: null } });
        const code = (0, node_crypto_1.randomInt)(0, 1_000_000).toString().padStart(6, "0");
        await tx.passwordRecovery.create({ data: {
                id, userId: user.id, deviceHash: fingerprint, codeHash: (0, session_service_1.secureHash)(`recovery:${id}:${code}`),
                expiresAt: new Date(clock.now.getTime() + 900_000),
            } });
        await (0, jobs_service_1.enqueue)(tx, "RECOVERY_OTP", `recovery:${id}`, { userId: user.id, challengeId: id, encryptedCode: (0, pii_service_1.encryptPii)(code) });
        await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: "PASSWORD_RECOVERY_REQUESTED" } });
    });
    // The shape and message are identical for existing, missing and temporarily locked accounts.
    return { challengeId: id, expiresIn: 900, message: "If those details match an account, a code will be sent to its registered phone. The code lasts 15 minutes." };
}
async function verifyRecoveryOtp(id, code, fingerprint) {
    const grant = (0, node_crypto_1.randomBytes)(32).toString("hex");
    const result = await (0, transaction_service_1.serializable)(async (tx) => {
        const found = await tx.passwordRecovery.findUnique({ where: { id } });
        if (!found)
            return false;
        await tx.$queryRaw `SELECT id FROM "User" WHERE id = ${found.userId} FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: found.userId } });
        const challenge = await tx.passwordRecovery.findUniqueOrThrow({ where: { id } });
        const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
        if (!clock)
            throw new Error("Database clock unavailable");
        if (user.isDemo !== (0, demo_1.isDemoMode)() || challenge.consumedAt || challenge.verifiedAt || challenge.expiresAt <= clock.now
            || challenge.deviceHash !== fingerprint || (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now))
            return false;
        const failures = user.recoveryLockedUntil ? 0 : user.recoveryFailures;
        if (!matches(challenge.codeHash, (0, session_service_1.secureHash)(`recovery:${id}:${code}`))) {
            const next = failures + 1;
            await tx.user.update({ where: { id: user.id }, data: {
                    recoveryFailures: next, recoveryLockedUntil: next >= 3 ? new Date(clock.now.getTime() + 3_600_000) : null,
                } });
            if (next >= 3)
                await tx.passwordRecovery.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now, grantHash: null } });
            await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: next >= 3 ? "RECOVERY_LOCKED_ONE_HOUR" : "RECOVERY_CODE_FAILED" } });
            return false;
        }
        await tx.passwordRecovery.update({ where: { id }, data: { verifiedAt: clock.now, grantHash: (0, session_service_1.secureHash)(`reset:${grant}`) } });
        return true;
    });
    if (!result)
        throw invalid();
    return { resetToken: grant, message: "Code confirmed. Choose a new password before the 15-minute reset window ends." };
}
async function resetPassword(token, password, fingerprint) {
    const hash = await (0, auth_service_1.hashPassword)(exports.passwordSchema.parse(password));
    const success = await (0, transaction_service_1.serializable)(async (tx) => {
        const found = await tx.passwordRecovery.findUnique({ where: { grantHash: (0, session_service_1.secureHash)(`reset:${token}`) } });
        if (!found)
            return false;
        await tx.$queryRaw `SELECT id FROM "User" WHERE id = ${found.userId} FOR UPDATE`;
        const user = await tx.user.findUniqueOrThrow({ where: { id: found.userId } });
        const grant = await tx.passwordRecovery.findUniqueOrThrow({ where: { id: found.id } });
        const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
        if (!clock)
            throw new Error("Database clock unavailable");
        if (user.isDemo !== (0, demo_1.isDemoMode)() || !grant.verifiedAt || grant.consumedAt || grant.expiresAt <= clock.now
            || grant.deviceHash !== fingerprint || (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now))
            return false;
        await tx.user.update({ where: { id: user.id }, data: {
                passwordHash: hash, credentialVersion: { increment: 1 }, recoveryFailures: 0, recoveryLockedUntil: null,
            } });
        await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: clock.now } });
        await tx.authChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now } });
        await tx.passwordRecovery.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now, grantHash: null } });
        await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: "PASSWORD_RESET_ALL_SESSIONS_REVOKED" } });
        return true;
    });
    if (!success)
        throw invalid();
    return { reset: true, message: "Your password has changed. You have been signed out on every device. Sign in with your new password." };
}
