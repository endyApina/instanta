import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";
import { serializable } from "./transaction.service";
import { secureHash, enforceRateLimit } from "./session.service";
import { piiLookupHash, encryptPii } from "./pii.service";
import { enqueue } from "./jobs.service";
import { hashPassword } from "./auth.service";
import { isDemoMode } from "../config/demo";

export const passwordSchema = z.string().min(12, "Use at least 12 characters for your password.")
  .max(72, "Use no more than 72 characters.").refine((value) => Buffer.byteLength(value) <= 72, "Your password is too long. Use fewer characters.");
export const recoveryContactSchema = z.string().trim().max(254).refine((value) =>
  z.email().safeParse(value).success || /^\+234[789]\d{9}$/.test(value), "Enter your email or Nigerian mobile number, such as +2348012345678.");
function matches(expected: string, actual: string) {
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
const invalid = () => new AppError(401, "RECOVERY_CODE_INVALID", "That code cannot be used. It may be wrong, expired or already used. After three wrong codes, wait one hour.");

export async function forgotPassword(contact: string, fingerprint: string) {
  const normalized = contact.toLowerCase();
  await enforceRateLimit(`recover-contact:${normalized}`, 5, 3600, "Too many reset requests. Please wait an hour before trying again.");
  const id = randomUUID();
  await serializable(async (tx) => {
    const where = normalized.includes("@")
      ? { emailLookupHash: piiLookupHash(`email:${normalized}`) }
      : { phoneLookupHash: piiLookupHash(`phone:${normalized}`) };
    const found = await tx.user.findUnique({ where });
    if (!found || found.isDemo !== isDemoMode()) return;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${found.id} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: found.id } });
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (!clock) throw new Error("Database clock unavailable");
    if (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now) return;
    if (!user.phoneEncrypted) return;
    if (user.recoveryLockedUntil) await tx.user.update({ where: { id: user.id }, data: { recoveryFailures: 0, recoveryLockedUntil: null } });
    await tx.passwordRecovery.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now, grantHash: null } });
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await tx.passwordRecovery.create({ data: {
      id, userId: user.id, deviceHash: fingerprint, codeHash: secureHash(`recovery:${id}:${code}`),
      expiresAt: new Date(clock.now.getTime() + 900_000),
    } });
    await enqueue(tx, "RECOVERY_OTP", `recovery:${id}`, { userId: user.id, challengeId: id, encryptedCode: encryptPii(code) });
    await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: "PASSWORD_RECOVERY_REQUESTED" } });
  });
  // The shape and message are identical for existing, missing and temporarily locked accounts.
  return { challengeId: id, expiresIn: 900, message: "If those details match an account, a code will be sent to its registered phone. The code lasts 15 minutes." };
}

export async function verifyRecoveryOtp(id: string, code: string, fingerprint: string) {
  const grant = randomBytes(32).toString("hex");
  const result = await serializable(async (tx) => {
    const found = await tx.passwordRecovery.findUnique({ where: { id } });
    if (!found) return false;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${found.userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: found.userId } });
    const challenge = await tx.passwordRecovery.findUniqueOrThrow({ where: { id } });
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (!clock) throw new Error("Database clock unavailable");
    if (user.isDemo !== isDemoMode() || challenge.consumedAt || challenge.verifiedAt || challenge.expiresAt <= clock.now
      || challenge.deviceHash !== fingerprint || (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now)) return false;
    const failures = user.recoveryLockedUntil ? 0 : user.recoveryFailures;
    if (!matches(challenge.codeHash, secureHash(`recovery:${id}:${code}`))) {
      const next = failures + 1;
      await tx.user.update({ where: { id: user.id }, data: {
        recoveryFailures: next, recoveryLockedUntil: next >= 3 ? new Date(clock.now.getTime() + 3_600_000) : null,
      } });
      if (next >= 3) await tx.passwordRecovery.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now, grantHash: null } });
      await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: next >= 3 ? "RECOVERY_LOCKED_ONE_HOUR" : "RECOVERY_CODE_FAILED" } });
      return false;
    }
    await tx.passwordRecovery.update({ where: { id }, data: { verifiedAt: clock.now, grantHash: secureHash(`reset:${grant}`) } });
    return true;
  });
  if (!result) throw invalid();
  return { resetToken: grant, message: "Code confirmed. Choose a new password before the 15-minute reset window ends." };
}

export async function resetPassword(token: string, password: string, fingerprint: string) {
  const hash = await hashPassword(passwordSchema.parse(password));
  const success = await serializable(async (tx) => {
    const found = await tx.passwordRecovery.findUnique({ where: { grantHash: secureHash(`reset:${token}`) } });
    if (!found) return false;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${found.userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: found.userId } });
    const grant = await tx.passwordRecovery.findUniqueOrThrow({ where: { id: found.id } });
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (!clock) throw new Error("Database clock unavailable");
    if (user.isDemo !== isDemoMode() || !grant.verifiedAt || grant.consumedAt || grant.expiresAt <= clock.now
      || grant.deviceHash !== fingerprint || (user.recoveryLockedUntil && user.recoveryLockedUntil > clock.now)) return false;
    await tx.user.update({ where: { id: user.id }, data: {
      passwordHash: hash, credentialVersion: { increment: 1 }, recoveryFailures: 0, recoveryLockedUntil: null,
    } });
    await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: clock.now } });
    await tx.authChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now } });
    await tx.passwordRecovery.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: clock.now, grantHash: null } });
    await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: "PASSWORD_RESET_ALL_SESSIONS_REVOKED" } });
    return true;
  });
  if (!success) throw invalid();
  return { reset: true, message: "Your password has changed. You have been signed out on every device. Sign in with your new password." };
}
