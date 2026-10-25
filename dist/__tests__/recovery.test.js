"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const node_test_1 = __importDefault(require("node:test"));
(0, node_test_1.default)("password recovery protects codes, lockouts and every active session", {
    skip: process.env.RUN_DB_TESTS !== "true", timeout: 30_000,
}, async (suite) => {
    strict_1.default.ok(new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_hardening_test"));
    process.env.NODE_ENV = "test";
    process.env.IS_DEMO_MODE = "false";
    process.env.JWT_SECRET = "recovery-test-key-at-least-thirty-two-characters";
    process.env.PII_ENCRYPTION_KEY = "c".repeat(64);
    const { prisma } = await Promise.resolve().then(() => __importStar(require("../config/prisma")));
    const { app } = await Promise.resolve().then(() => __importStar(require("../app")));
    const { encryptPii, decryptPii, piiLookupHash } = await Promise.resolve().then(() => __importStar(require("../services/pii.service")));
    const { hashPassword, verifyPassword, issueAccessToken } = await Promise.resolve().then(() => __importStar(require("../services/auth.service")));
    const { deviceFingerprint, beginChallenge, completeChallenge } = await Promise.resolve().then(() => __importStar(require("../services/session.service")));
    const email = `${(0, node_crypto_1.randomUUID)()}@example.com`;
    const phone = `+2348${(0, node_crypto_1.randomInt)(0, 1_000_000_000).toString().padStart(9, "0")}`;
    const device = (0, node_crypto_1.randomUUID)();
    const fingerprint = deviceFingerprint(device, "127.0.0.1");
    const server = app.listen(0, "127.0.0.1");
    await (0, node_events_1.once)(server, "listening");
    const address = server.address();
    strict_1.default.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    try {
        const user = await prisma.user.create({ data: {
                email: encryptPii(email), emailLookupHash: piiLookupHash(`email:${email}`),
                phoneEncrypted: encryptPii(phone), phoneLookupHash: piiLookupHash(`phone:${phone}`),
                firstName: encryptPii("Recovery"), lastName: encryptPii("Test"), passwordHash: await hashPassword("Old-password-123"),
            } });
        async function call(path, body, token, deviceId = device) {
            const response = await fetch(`${base}${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: { "x-device-id": deviceId, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: await response.json() };
        }
        async function requestCode(contact = email) {
            const result = await call("/auth/forgot-password", { contact });
            strict_1.default.equal(result.status, 200);
            const id = result.body.data.challengeId;
            const job = await prisma.outboxJob.findUniqueOrThrow({ where: { uniqueKey: `recovery:${id}` } });
            strict_1.default.ok(job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) && typeof job.payload.encryptedCode === "string");
            return { id, code: decryptPii(job.payload.encryptedCode) };
        }
        const first = await requestCode();
        await suite.test("unknown accounts receive the same status, message and response shape", async () => {
            const unknown = await call("/auth/forgot-password", { contact: `${(0, node_crypto_1.randomUUID)()}@example.com` });
            strict_1.default.equal(unknown.status, 200);
            strict_1.default.deepEqual(Object.keys(unknown.body.data).sort(), ["challengeId", "expiresIn", "message"]);
            strict_1.default.equal(unknown.body.data.message, (await call("/auth/forgot-password", { email })).body.data.message);
            strict_1.default.equal(await prisma.passwordRecovery.count({ where: { id: unknown.body.data.challengeId } }), 0);
        });
        await suite.test("expired and superseded codes cannot verify", async () => {
            strict_1.default.equal((await call("/auth/verify-recovery-otp", { challengeId: first.id, code: first.code })).status, 401);
            const challenge = await requestCode();
            await prisma.passwordRecovery.update({ where: { id: challenge.id }, data: { expiresAt: new Date(0) } });
            strict_1.default.equal((await call("/auth/verify-recovery-otp", { challengeId: challenge.id, code: challenge.code })).status, 401);
        });
        let current = await requestCode();
        await suite.test("three failures persist across reissued challenges and lock for one hour", async () => {
            for (let i = 0; i < 3; i++) {
                const code = current.code === "000000" ? "111111" : "000000";
                strict_1.default.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code })).status, 401);
                if (i === 0) {
                    current = await requestCode(phone);
                }
            }
            const locked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
            strict_1.default.equal(locked.recoveryFailures, 3);
            strict_1.default.ok(locked.recoveryLockedUntil && locked.recoveryLockedUntil.getTime() > Date.now() + 3_590_000);
            await strict_1.default.rejects(beginChallenge(user.id, fingerprint, user.credentialVersion), /one hour/);
            strict_1.default.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code })).status, 401);
        });
        // Clear request throttling solely to test hour expiry without sleeping an hour.
        await prisma.rateLimitBucket.deleteMany({});
        await prisma.user.update({ where: { id: user.id }, data: { recoveryLockedUntil: new Date(0) } });
        current = await requestCode();
        const session = await prisma.authSession.create({ data: { userId: user.id, deviceHash: fingerprint, expiresAt: new Date(Date.now() + 3600_000) } });
        const second = await prisma.authSession.create({ data: { userId: user.id, deviceHash: "other-device", expiresAt: new Date(Date.now() + 3600_000) } });
        const oldToken = issueAccessToken(user.id, session.id, fingerprint);
        const oldChallenge = await beginChallenge(user.id, fingerprint, user.credentialVersion);
        const otpJob = await prisma.outboxJob.findUniqueOrThrow({ where: { uniqueKey: `otp:${oldChallenge.challengeId}` } });
        strict_1.default.ok(otpJob.payload && typeof otpJob.payload === "object" && !Array.isArray(otpJob.payload) && typeof otpJob.payload.encryptedCode === "string");
        const oldCode = decryptPii(otpJob.payload.encryptedCode);
        let grant = "";
        await suite.test("recovery unlocks after an hour and is bound to the requesting device", async () => {
            strict_1.default.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code }, undefined, (0, node_crypto_1.randomUUID)())).status, 401);
            const result = await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code });
            strict_1.default.equal(result.status, 200);
            grant = result.body.data.resetToken;
            strict_1.default.equal(grant.length, 64);
            strict_1.default.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code })).status, 401);
            const stored = await prisma.passwordRecovery.findUniqueOrThrow({ where: { id: current.id } });
            strict_1.default.notEqual(stored.grantHash, grant);
        });
        await suite.test("reset is single-use, strongly hashed and revokes every session and pending login", async () => {
            const result = await call("/auth/reset-password", { resetToken: grant, password: "New-password-456" });
            strict_1.default.equal(result.status, 200);
            const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
            strict_1.default.equal(await verifyPassword("New-password-456", updated.passwordHash), true);
            strict_1.default.equal(await verifyPassword("Old-password-123", updated.passwordHash), false);
            strict_1.default.equal(updated.credentialVersion, user.credentialVersion + 1);
            strict_1.default.ok((await prisma.authSession.findUniqueOrThrow({ where: { id: second.id } })).revokedAt);
            strict_1.default.equal((await call("/dashboard", undefined, oldToken)).status, 401);
            await strict_1.default.rejects(completeChallenge(oldChallenge.challengeId, oldCode, fingerprint));
            await strict_1.default.rejects(beginChallenge(user.id, fingerprint, user.credentialVersion), /sign in again/);
            strict_1.default.equal((await call("/auth/reset-password", { resetToken: grant, password: "Another-password-789" })).status, 401);
        });
        await suite.test("recovery issuance is rate-limited without leaking the destination", async () => {
            const contact = `${(0, node_crypto_1.randomUUID)()}@example.com`;
            for (let i = 0; i < 5; i++)
                strict_1.default.equal((await call("/auth/forgot-password", { contact })).status, 200);
            strict_1.default.equal((await call("/auth/forgot-password", { contact })).status, 429);
        });
    }
    finally {
        await new Promise((resolve) => server.close(() => resolve()));
        await prisma.$disconnect();
    }
});
