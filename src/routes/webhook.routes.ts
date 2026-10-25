import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../errors/app-error";
import { applyKycResult } from "../services/kyc.service";
import { baasSchema, encryptedPayload, enqueue } from "../services/jobs.service";
import { serializable } from "../services/transaction.service";
import { requestHash } from "../domain/request-hash";
import { moneyAmount } from "../domain/money";

export const webhookRoutes = Router();
webhookRoutes.use((_request, _response, next) => {
  next(process.env.IS_DEMO_MODE === "true" ? new AppError(403, "DEMO_WEBHOOK_DISABLED", "Bank and identity webhooks are disabled in demo mode.") : undefined);
});

export function verifyWebhook(rawBody: Buffer | undefined, signature: string | undefined, secret: string | undefined): void {
  if (!secret) throw new AppError(503, "WEBHOOK_NOT_CONFIGURED", "Webhook verification is not configured");
  if (!rawBody || !signature || !/^(sha256=)?[a-fA-F0-9]{64}$/.test(signature)) {
    throw new AppError(401, "INVALID_WEBHOOK_SIGNATURE", "A valid webhook signature is required");
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (!timingSafeEqual(Buffer.from(signature.replace(/^sha256=/, ""), "hex"), expected)) {
    throw new AppError(401, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid");
  }
}

webhookRoutes.post("/baas", async (request, response, next) => {
  try {
    verifyWebhook(request.rawBody, request.header("x-baas-signature"), process.env.BAAS_WEBHOOK_SECRET);
    const payload = baasSchema.parse(request.body);
    moneyAmount(payload.amount);
    const result = await serializable(async (tx) => {
      const id = `baas:${payload.eventId}`;
      const transactionKey = `baas:${payload.eventType}:${payload.reference}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${transactionKey}, 2))`;
      const existing = await tx.webhookInbox.findFirst({ where: { OR: [{ id }, { transactionKey }] } });
      const hash = requestHash({ ...payload, eventId: undefined });
      if (existing) {
        if (existing.requestHash !== hash) throw new AppError(409, "WEBHOOK_CONFLICT", "Event or transaction reference was replayed with different content");
        return { inboxId: existing.id, duplicate: true };
      }
      await tx.webhookInbox.create({
        data: { id, transactionKey, requestHash: hash, payloadEncrypted: encryptedPayload(payload) },
      });
      await enqueue(tx, "RECONCILE_WEBHOOK", id, { inboxId: id });
      return { inboxId: id, duplicate: false };
    });
    // Receipt is durable even during read-only mode; the worker defers actual postings until resumed.
    response.status(202).json({ success: true, data: { ...result, status: "ACCEPTED_FOR_RECONCILIATION" } });
  } catch (error) { next(error); }
});

webhookRoutes.post("/kyc", async (request, response, next) => {
  try {
    verifyWebhook(request.rawBody, request.header("x-kyc-signature"), process.env.KYC_WEBHOOK_SECRET);
    const payload = z.object({
      verificationId: z.string().min(1), userId: z.string().min(1),
      status: z.enum(["VERIFIED", "REJECTED"]),
      level: z.enum(["TIER_1", "TIER_2", "TIER_3"]).optional(),
    }).parse(request.body);
    await applyKycResult(payload.userId, payload.verificationId, payload.status, payload.level);
    response.json({ success: true, data: { received: true } });
  } catch (error) { next(error); }
});
