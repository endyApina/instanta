"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookRoutes = void 0;
exports.verifyWebhook = verifyWebhook;
const node_crypto_1 = require("node:crypto");
const express_1 = require("express");
const zod_1 = require("zod");
const app_error_1 = require("../errors/app-error");
const kyc_service_1 = require("../services/kyc.service");
const jobs_service_1 = require("../services/jobs.service");
const transaction_service_1 = require("../services/transaction.service");
const request_hash_1 = require("../domain/request-hash");
const money_1 = require("../domain/money");
exports.webhookRoutes = (0, express_1.Router)();
exports.webhookRoutes.use((_request, _response, next) => {
    next(process.env.IS_DEMO_MODE === "true" ? new app_error_1.AppError(403, "DEMO_WEBHOOK_DISABLED", "Bank and identity webhooks are disabled in demo mode.") : undefined);
});
function verifyWebhook(rawBody, signature, secret) {
    if (!secret)
        throw new app_error_1.AppError(503, "WEBHOOK_NOT_CONFIGURED", "Webhook verification is not configured");
    if (!rawBody || !signature || !/^(sha256=)?[a-fA-F0-9]{64}$/.test(signature)) {
        throw new app_error_1.AppError(401, "INVALID_WEBHOOK_SIGNATURE", "A valid webhook signature is required");
    }
    const expected = (0, node_crypto_1.createHmac)("sha256", secret).update(rawBody).digest();
    if (!(0, node_crypto_1.timingSafeEqual)(Buffer.from(signature.replace(/^sha256=/, ""), "hex"), expected)) {
        throw new app_error_1.AppError(401, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid");
    }
}
exports.webhookRoutes.post("/baas", async (request, response, next) => {
    try {
        verifyWebhook(request.rawBody, request.header("x-baas-signature"), process.env.BAAS_WEBHOOK_SECRET);
        const payload = jobs_service_1.baasSchema.parse(request.body);
        (0, money_1.moneyAmount)(payload.amount);
        const result = await (0, transaction_service_1.serializable)(async (tx) => {
            const id = `baas:${payload.eventId}`;
            const transactionKey = `baas:${payload.eventType}:${payload.reference}`;
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${transactionKey}, 2))`;
            const existing = await tx.webhookInbox.findFirst({ where: { OR: [{ id }, { transactionKey }] } });
            const hash = (0, request_hash_1.requestHash)({ ...payload, eventId: undefined });
            if (existing) {
                if (existing.requestHash !== hash)
                    throw new app_error_1.AppError(409, "WEBHOOK_CONFLICT", "Event or transaction reference was replayed with different content");
                return { inboxId: existing.id, duplicate: true };
            }
            await tx.webhookInbox.create({
                data: { id, transactionKey, requestHash: hash, payloadEncrypted: (0, jobs_service_1.encryptedPayload)(payload) },
            });
            await (0, jobs_service_1.enqueue)(tx, "RECONCILE_WEBHOOK", id, { inboxId: id });
            return { inboxId: id, duplicate: false };
        });
        // Receipt is durable even during read-only mode; the worker defers actual postings until resumed.
        response.status(202).json({ success: true, data: { ...result, status: "ACCEPTED_FOR_RECONCILIATION" } });
    }
    catch (error) {
        next(error);
    }
});
exports.webhookRoutes.post("/kyc", async (request, response, next) => {
    try {
        verifyWebhook(request.rawBody, request.header("x-kyc-signature"), process.env.KYC_WEBHOOK_SECRET);
        const payload = zod_1.z.object({
            verificationId: zod_1.z.string().min(1), userId: zod_1.z.string().min(1),
            status: zod_1.z.enum(["VERIFIED", "REJECTED"]),
            level: zod_1.z.enum(["TIER_1", "TIER_2", "TIER_3"]).optional(),
        }).parse(request.body);
        await (0, kyc_service_1.applyKycResult)(payload.userId, payload.verificationId, payload.status, payload.level);
        response.json({ success: true, data: { received: true } });
    }
    catch (error) {
        next(error);
    }
});
