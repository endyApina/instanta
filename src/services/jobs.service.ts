import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { partners } from "../adapters";
import { decryptPii, encryptPii } from "./pii.service";
import { createDepositJournal, createWithdrawalJournal } from "./ledger.service";
import { assertWritable, serializable, isRetryableTransactionError } from "./transaction.service";
import { AppError } from "../errors/app-error";

export const baasSchema = z.object({
  eventId: z.string().min(1).max(200), eventType: z.enum(["DEPOSIT", "WITHDRAWAL"]),
  virtualAccountNumber: z.string().min(5).max(64),
  amount: z.string().regex(/^\d{1,18}(\.\d{1,2})?$/),
  currency: z.literal("NGN"), reference: z.string().min(1).max(200), occurredAt: z.string().datetime(),
});

export async function enqueue(tx: Prisma.TransactionClient, kind: string, uniqueKey: string, payload: Prisma.InputJsonObject) {
  return tx.outboxJob.upsert({ where: { uniqueKey }, create: { kind, uniqueKey, payload }, update: {} });
}

export async function reconcileInbox(tx: Prisma.TransactionClient, id: string) {
  await assertWritable(tx);
  const inbox = await tx.webhookInbox.findUniqueOrThrow({ where: { id } });
  if (inbox.processedAt) return;
  const payload = baasSchema.parse(JSON.parse(decryptPii(inbox.payloadEncrypted)));
  const wallet = await tx.wallet.findUnique({
    where: { virtualAccountNumber: payload.virtualAccountNumber }, include: { ledgerAccount: true },
  });
  if (!wallet || !wallet.ledgerAccount || wallet.status !== "ACTIVE") {
    throw new AppError(409, "ACCOUNT_NOT_READY", "Deposit reconciliation is waiting for an active mapped account");
  }
  const post = payload.eventType === "DEPOSIT" ? createDepositJournal : createWithdrawalJournal;
  const journal = await post(tx, wallet.ledgerAccount.id, payload.amount, payload.eventId, payload.reference);
  await tx.webhookInbox.update({
    where: { id }, data: { processedAt: new Date(), journalId: journal.id },
  });
  await enqueue(tx, "TRANSACTION_ALERT", `alert:${id}`, { userId: wallet.userId, journalId: journal.id });
}

async function executeJob(tx: Prisma.TransactionClient, kind: string, payload: unknown) {
  const ids = z.object({ userId: z.string() });
  if (kind === "RECONCILE_WEBHOOK") {
    const { inboxId } = z.object({ inboxId: z.string() }).parse(payload);
    await reconcileInbox(tx, inboxId);
    return;
  }
  if (kind === "OTP") {
    const { challengeId, encryptedCode } = z.object({ challengeId: z.string(), encryptedCode: z.string() }).parse(payload);
    const challenge = await tx.authChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (challenge.consumedAt || !clock || challenge.expiresAt <= clock.now) return;
    const user = await tx.user.findUniqueOrThrow({ where: { id: challenge.userId } });
    if (!user.phoneEncrypted) throw new AppError(409, "PHONE_REQUIRED", "No registered OTP destination");
    await tx.auditEvent.create({ data: { actorId: "worker", subjectId: user.id, action: "OTP_DESTINATION_ACCESS" } });
    await partners().notifications.sendOtp(challengeId, decryptPii(user.phoneEncrypted), decryptPii(encryptedCode));
    return;
  }
  if (kind === "RECOVERY_OTP") {
    const { challengeId, encryptedCode } = z.object({ challengeId: z.string(), encryptedCode: z.string() }).parse(payload);
    const recovery = await tx.passwordRecovery.findUnique({ where: { id: challengeId } });
    if (!recovery) {
      console.info(`[INFO] Expired recovery notification cancelled: ${challengeId}`);
      return;
    }
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (!clock || recovery.consumedAt || recovery.verifiedAt || recovery.expiresAt <= clock.now) return;
    const user = await tx.user.findUniqueOrThrow({ where: { id: recovery.userId } });
    if (!user.phoneEncrypted) throw new AppError(409, "PHONE_REQUIRED", "Your account needs a registered phone. Please contact support.");
    await tx.auditEvent.create({ data: { actorId: "worker", subjectId: user.id, action: "RECOVERY_PHONE_ACCESS" } });
    await partners().notifications.sendOtp(challengeId, decryptPii(user.phoneEncrypted), decryptPii(encryptedCode));
    return;
  }
  const { userId } = ids.parse(payload);
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (kind === "KYC") {
    const { verificationId } = z.object({ verificationId: z.string() }).parse(payload);
    await tx.$queryRaw`SELECT id FROM "KycVerification" WHERE id = ${verificationId} FOR UPDATE`;
    const verification = await tx.kycVerification.findUniqueOrThrow({ where: { id: verificationId } });
    if (verification.status !== "PENDING") return;
    await tx.auditEvent.create({ data: { actorId: "worker", subjectId: userId, action: "KYC_IDENTITY_ACCESS" } });
    const result = await partners().kyc.verify({
      userId, reference: verificationId,
      ...(user.bvnEncrypted ? { bvn: decryptPii(user.bvnEncrypted) } : {}),
      ...(user.ninEncrypted ? { nin: decryptPii(user.ninEncrypted) } : {}),
    });
    await tx.kycVerification.update({
      where: { id: verificationId }, data: {
        providerReference: result.reference, status: result.status,
        completedAt: result.status === "PENDING" ? null : new Date(),
      },
    });
    await tx.user.update({ where: { id: userId }, data: { kycStatus: result.status } });
    return;
  }
  if (kind === "VIRTUAL_ACCOUNT") {
    await assertWritable(tx);
    if (user.kycStatus !== "VERIFIED") throw new AppError(409, "KYC_REQUIRED", "Virtual account issuance is waiting for verified identity");
    const account = await partners().baas.createAccount(userId);
    await tx.wallet.update({
      where: { userId }, data: {
        virtualAccountNumber: account.accountNumber,
        virtualAccountName: account.accountName, virtualAccountBank: account.bankName,
      },
    });
    return;
  }
  if (kind === "TRANSACTION_ALERT") {
    const { journalId } = z.object({ journalId: z.string() }).parse(payload);
    if (!user.phoneEncrypted) throw new AppError(409, "PHONE_REQUIRED", "No transaction-alert destination");
    await tx.auditEvent.create({ data: { actorId: "worker", subjectId: userId, action: "ALERT_DESTINATION_ACCESS" } });
    await partners().notifications.sendAlert(journalId, decryptPii(user.phoneEncrypted), "A transaction was recorded in your Instanta account. Sign in to review it.");
    return;
  }
  throw new AppError(500, "UNKNOWN_JOB", "Unknown outbox job type");
}

export async function processNextJob(): Promise<boolean> {
  return serializable(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; kind: string; payload: Prisma.JsonValue; attempts: number }[]>`
      SELECT id, kind, payload, attempts FROM "OutboxJob"
      WHERE "completedAt" IS NULL AND "deadAt" IS NULL AND "availableAt" <= clock_timestamp()
      ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 1
    `;
    const job = rows[0];
    if (!job) return false;
    const payload = job.payload;
    const subjectId = payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.userId === "string"
      ? payload.userId : job.id;
    // Retain the access attempt even when partner work rolls back to its savepoint.
    await tx.auditEvent.create({ data: { actorId: "worker", subjectId, action: `JOB_ATTEMPT:${job.kind}` } });
    // A savepoint rolls back partial internal side effects while retaining the durable retry counter.
    await tx.$executeRawUnsafe("SAVEPOINT job_attempt");
    try {
      await executeJob(tx, job.kind, job.payload);
      await tx.outboxJob.update({
        where: { id: job.id }, data: { completedAt: new Date(), payload: {}, lastError: null },
      });
    } catch (error) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT job_attempt");
      if (isRetryableTransactionError(error)) throw error;
      const attempts = job.attempts + 1;
      const paused = error instanceof AppError && ["SYSTEM_READ_ONLY", "SYSTEM_CONTROL_UNAVAILABLE"].includes(error.code);
      console.error(`[${attempts >= 10 && !paused ? "ALERT" : "WARN"}] Outbox retry kind=${job.kind} id=${job.id} attempt=${attempts}`);
      await tx.outboxJob.update({
        where: { id: job.id }, data: {
          attempts: paused ? job.attempts : attempts,
          availableAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8))),
          deadAt: !paused && attempts >= 10 ? new Date() : null,
          lastError: error instanceof AppError ? error.code : "INTERNAL_JOB_ERROR",
        },
      });
    }
    return true;
  });
}

export function encryptedPayload(value: unknown): string {
  return encryptPii(JSON.stringify(value));
}

export async function cleanupExpiredSecurityRecords(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "PasswordRecovery" WHERE "expiresAt" < clock_timestamp()`;
  await prisma.$executeRaw`
    UPDATE "SavingsGoal" SET status = 'ACTIVE', "updatedAt" = clock_timestamp()
    WHERE status = 'LOCKED' AND "lockUntil" <= clock_timestamp()
  `;
  await prisma.$executeRaw`DELETE FROM "IdempotencyRecord" WHERE "expiresAt" < clock_timestamp()`;
  await prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "expiresAt" < clock_timestamp()`;
  await prisma.$executeRaw`DELETE FROM "AuthChallenge" WHERE "expiresAt" < clock_timestamp() - interval '1 day'`;
  await prisma.$executeRaw`DELETE FROM "AuthSession" WHERE "expiresAt" < clock_timestamp() - interval '1 day'`;
}
