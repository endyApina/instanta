import { createHmac, randomInt, randomUUID } from "node:crypto";
import type { Request } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";
import { serializable } from "./transaction.service";
import { enqueue } from "./jobs.service";
import { encryptPii } from "./pii.service";
import { issueAccessToken } from "./auth.service";
import { isDemoMode } from "../config/demo";

export function secureHash(value: string): string {
  const key = process.env.JWT_SECRET;
  if (!key || key.length < 32) throw new AppError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured");
  return createHmac("sha256", key).update(value).digest("hex");
}

export function deviceHash(request: Request): string {
  return deviceFingerprint(request.header("x-device-id"), request.ip ?? request.socket.remoteAddress ?? "unknown");
}

export function deviceFingerprint(id: string | undefined, ip: string): string {
  if (!id || !/^[a-zA-Z0-9_-]{20,128}$/.test(id)) {
    throw new AppError(400, "DEVICE_ID_REQUIRED", "We couldn't recognize this device. Refresh the page and try again.");
  }
  // Express trust proxy stays disabled: never trust caller-supplied X-Forwarded-For.
  return secureHash(`${id}\0${ip}`);
}

export async function enforceRateLimit(
  key: string, limit: number, windowSeconds: number,
  message = "Too many authentication attempts. Try again later.",
): Promise<void> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" (key, count, "expiresAt")
    VALUES (${secureHash(key)}, 1, clock_timestamp() + make_interval(secs => ${windowSeconds}))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "RateLimitBucket"."expiresAt" <= clock_timestamp() THEN 1 ELSE "RateLimitBucket".count + 1 END,
      "expiresAt" = CASE WHEN "RateLimitBucket"."expiresAt" <= clock_timestamp()
        THEN clock_timestamp() + make_interval(secs => ${windowSeconds}) ELSE "RateLimitBucket"."expiresAt" END
    RETURNING count
  `;
  if ((rows[0]?.count ?? limit + 1) > limit) throw new AppError(429, "RATE_LIMITED", message);
}

export async function beginChallenge(userId: string, fingerprint: string, credentialVersion?: number) {
  await enforceRateLimit(`otp-user:${userId}`, 5, 900);
  return serializable(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.isDemo !== isDemoMode() || (credentialVersion !== undefined && user.credentialVersion !== credentialVersion)) {
      throw new AppError(401, "SIGN_IN_AGAIN", "Your account changed. Please sign in again.");
    }
    if (!user.phoneEncrypted) throw new AppError(409, "PHONE_ENROLLMENT_REQUIRED", "This account needs a registered phone. Contact support for identity-verified enrollment.");
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (!clock) throw new Error("Database clock unavailable");
    const { now } = clock;
    if (user.recoveryLockedUntil && user.recoveryLockedUntil > now) throw new AppError(429, "ACCOUNT_TEMPORARILY_LOCKED", "Your account is temporarily locked after three wrong recovery codes. Please wait one hour.");
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await tx.authChallenge.create({
      data: { id, userId, credentialVersion: user.credentialVersion, deviceHash: fingerprint, codeHash: secureHash(`${id}:${code}`),
        expiresAt: new Date(now.getTime() + 300_000) },
    });
    await enqueue(tx, "OTP", `otp:${id}`, { userId, challengeId: id, encryptedCode: encryptPii(code) });
    await tx.auditEvent.create({ data: { actorId: userId, subjectId: userId, action: "MFA_CHALLENGE_CREATED" } });
    return { challengeId: id, mfaRequired: true, expiresIn: 300 };
  });
}

export async function completeChallenge(id: string, code: string, fingerprint: string) {
  const outcome = await serializable(async (tx) => {
    const found = await tx.authChallenge.findUnique({ where: { id } });
    if (!found) return null;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${found.userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: found.userId } });
    await tx.$queryRaw`SELECT id FROM "AuthChallenge" WHERE id = ${id} FOR UPDATE`;
    const challenge = await tx.authChallenge.findUnique({ where: { id } });
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (!challenge || !clock || challenge.expiresAt <= clock.now || challenge.consumedAt || challenge.attempts >= 5
      || challenge.deviceHash !== fingerprint || challenge.credentialVersion !== user.credentialVersion || user.isDemo !== isDemoMode()
      || (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now)) return null;
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
  if (!outcome) throw new AppError(401, "INVALID_OTP", "That code cannot be used. Check it and try again on the device where you requested it, or request a new code.");
  return {
    accessToken: issueAccessToken(outcome.userId, outcome.sessionId, fingerprint),
    tokenType: "Bearer", expiresIn: 3600,
  };
}
