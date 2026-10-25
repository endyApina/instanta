"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.idempotentMutation = idempotentMutation;
const client_1 = require("@prisma/client");
const prisma_1 = require("../config/prisma");
const app_error_1 = require("../errors/app-error");
const transaction_service_1 = require("../services/transaction.service");
const request_hash_1 = require("../domain/request-hash");
function cachedBody(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Corrupt idempotency response");
    return value;
}
// Handler side effects and cached response commit together; never send a success before COMMIT.
function idempotentMutation(handler, principal = (request) => request.userId, prepare) {
    return async (request, response, next) => {
        try {
            const supplied = request.header("idempotency-key");
            if (!supplied || !/^[a-zA-Z0-9:_-]{8,200}$/.test(supplied)) {
                throw new app_error_1.AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Supply an Idempotency-Key (8-200 letters, digits, : _ or -)");
            }
            const owner = principal(request);
            if (!owner)
                throw new app_error_1.AppError(401, "UNAUTHORIZED", "Authenticate before using idempotency");
            const key = (0, request_hash_1.requestHash)([owner, request.method, request.originalUrl, supplied]);
            const hash = (0, request_hash_1.requestHash)(request.body);
            if (prepare) {
                // A committed replay must not depend on current partner availability or current prices.
                const replay = await (0, transaction_service_1.serializable)(async (tx) => {
                    const existing = await tx.idempotencyRecord.findUnique({ where: { key } });
                    const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
                    if (!clock)
                        throw new Error("Database clock unavailable");
                    if (!existing || existing.expiresAt <= clock.now)
                        return null;
                    if (existing.requestHash !== hash)
                        throw new app_error_1.AppError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used with a different request");
                    return { status: existing.statusCode, body: cachedBody(existing.response) };
                });
                if (replay) {
                    response.status(replay.status).json(replay.body);
                    return;
                }
                await prepare(request);
            }
            const run = async () => (0, transaction_service_1.serializable)(async (tx) => {
                await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
                const existing = await tx.idempotencyRecord.findUnique({ where: { key } });
                const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
                if (!clock)
                    throw new Error("Database clock unavailable");
                const { now } = clock;
                if (existing && existing.expiresAt > now) {
                    if (existing.requestHash !== hash)
                        throw new app_error_1.AppError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used with a different request");
                    return { status: existing.statusCode, body: cachedBody(existing.response) };
                }
                if (existing)
                    await tx.idempotencyRecord.delete({ where: { key } });
                const result = await handler(request, tx);
                await tx.idempotencyRecord.create({
                    data: { key, requestHash: hash, response: result.body, statusCode: result.status,
                        expiresAt: new Date(now.getTime() + 86_400_000) },
                });
                return result;
            });
            let result;
            try {
                result = await run();
            }
            catch (error) {
                if (!(error instanceof client_1.Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
                    throw error;
                const existing = await prisma_1.prisma.idempotencyRecord.findUnique({ where: { key } });
                if (!existing || existing.expiresAt <= new Date())
                    throw error;
                if (existing.requestHash !== hash)
                    throw new app_error_1.AppError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used with a different request");
                result = { status: existing.statusCode, body: cachedBody(existing.response) };
            }
            response.status(result.status).json(result.body);
        }
        catch (error) {
            next(error);
        }
    };
}
