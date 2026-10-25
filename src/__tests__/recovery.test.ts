import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

test("password recovery protects codes, lockouts and every active session", {
  skip: process.env.RUN_DB_TESTS !== "true", timeout: 30_000,
}, async (suite) => {
  assert.ok(new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_hardening_test"));
  process.env.NODE_ENV = "test"; process.env.IS_DEMO_MODE = "false";
  process.env.JWT_SECRET = "recovery-test-key-at-least-thirty-two-characters";
  process.env.PII_ENCRYPTION_KEY = "c".repeat(64);
  const { prisma } = await import("../config/prisma");
  const { app } = await import("../app");
  const { encryptPii, decryptPii, piiLookupHash } = await import("../services/pii.service");
  const { hashPassword, verifyPassword, issueAccessToken } = await import("../services/auth.service");
  const { deviceFingerprint, beginChallenge, completeChallenge } = await import("../services/session.service");
  const email = `${randomUUID()}@example.com`;
  const phone = `+2348${randomInt(0, 1_000_000_000).toString().padStart(9, "0")}`;
  const device = randomUUID();
  const fingerprint = deviceFingerprint(device, "127.0.0.1");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  try {
    const user = await prisma.user.create({ data: {
      email: encryptPii(email), emailLookupHash: piiLookupHash(`email:${email}`),
      phoneEncrypted: encryptPii(phone), phoneLookupHash: piiLookupHash(`phone:${phone}`),
      firstName: encryptPii("Recovery"), lastName: encryptPii("Test"), passwordHash: await hashPassword("Old-password-123"),
    } });
    async function call(path: string, body?: unknown, token?: string, deviceId = device) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-device-id": deviceId, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    }
    async function requestCode(contact = email) {
      const result = await call("/auth/forgot-password", { contact });
      assert.equal(result.status, 200);
      const id: string = result.body.data.challengeId;
      const job = await prisma.outboxJob.findUniqueOrThrow({ where: { uniqueKey: `recovery:${id}` } });
      assert.ok(job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) && typeof job.payload.encryptedCode === "string");
      return { id, code: decryptPii(job.payload.encryptedCode) };
    }
    const first = await requestCode();
    await suite.test("unknown accounts receive the same status, message and response shape", async () => {
      const unknown = await call("/auth/forgot-password", { contact: `${randomUUID()}@example.com` });
      assert.equal(unknown.status, 200);
      assert.deepEqual(Object.keys(unknown.body.data).sort(), ["challengeId", "expiresIn", "message"]);
      assert.equal(unknown.body.data.message, (await call("/auth/forgot-password", { email })).body.data.message);
      assert.equal(await prisma.passwordRecovery.count({ where: { id: unknown.body.data.challengeId } }), 0);
    });
    await suite.test("expired and superseded codes cannot verify", async () => {
      assert.equal((await call("/auth/verify-recovery-otp", { challengeId: first.id, code: first.code })).status, 401);
      const challenge = await requestCode();
      await prisma.passwordRecovery.update({ where: { id: challenge.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await call("/auth/verify-recovery-otp", { challengeId: challenge.id, code: challenge.code })).status, 401);
    });
    let current = await requestCode();
    await suite.test("three failures persist across reissued challenges and lock for one hour", async () => {
      for (let i = 0; i < 3; i++) {
        const code = current.code === "000000" ? "111111" : "000000";
        assert.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code })).status, 401);
        if (i === 0) {
          current = await requestCode(phone);
        }
      }
      const locked = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.equal(locked.recoveryFailures, 3);
      assert.ok(locked.recoveryLockedUntil && locked.recoveryLockedUntil.getTime() > Date.now() + 3_590_000);
      await assert.rejects(beginChallenge(user.id, fingerprint, user.credentialVersion), /one hour/);
      assert.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code })).status, 401);
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
    assert.ok(otpJob.payload && typeof otpJob.payload === "object" && !Array.isArray(otpJob.payload) && typeof otpJob.payload.encryptedCode === "string");
    const oldCode = decryptPii(otpJob.payload.encryptedCode);
    let grant = "";
    await suite.test("recovery unlocks after an hour and is bound to the requesting device", async () => {
      assert.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code }, undefined, randomUUID())).status, 401);
      const result = await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code });
      assert.equal(result.status, 200); grant = result.body.data.resetToken;
      assert.equal(grant.length, 64);
      assert.equal((await call("/auth/verify-recovery-otp", { challengeId: current.id, code: current.code })).status, 401);
      const stored = await prisma.passwordRecovery.findUniqueOrThrow({ where: { id: current.id } });
      assert.notEqual(stored.grantHash, grant);
    });
    await suite.test("reset is single-use, strongly hashed and revokes every session and pending login", async () => {
      const result = await call("/auth/reset-password", { resetToken: grant, password: "New-password-456" });
      assert.equal(result.status, 200);
      const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.equal(await verifyPassword("New-password-456", updated.passwordHash), true);
      assert.equal(await verifyPassword("Old-password-123", updated.passwordHash), false);
      assert.equal(updated.credentialVersion, user.credentialVersion + 1);
      assert.ok((await prisma.authSession.findUniqueOrThrow({ where: { id: second.id } })).revokedAt);
      assert.equal((await call("/dashboard", undefined, oldToken)).status, 401);
      await assert.rejects(completeChallenge(oldChallenge.challengeId, oldCode, fingerprint));
      await assert.rejects(beginChallenge(user.id, fingerprint, user.credentialVersion), /sign in again/);
      assert.equal((await call("/auth/reset-password", { resetToken: grant, password: "Another-password-789" })).status, 401);
    });
    await suite.test("recovery issuance is rate-limited without leaking the destination", async () => {
      const contact = `${randomUUID()}@example.com`;
      for (let i = 0; i < 5; i++) assert.equal((await call("/auth/forgot-password", { contact })).status, 200);
      assert.equal((await call("/auth/forgot-password", { contact })).status, 429);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
});
