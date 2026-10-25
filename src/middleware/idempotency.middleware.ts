import { Prisma } from "@prisma/client";
import type { Request, RequestHandler } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";
import { serializable } from "../services/transaction.service";
import { requestHash } from "../domain/request-hash";

export interface MutationResult {
  status: number;
  body: Prisma.InputJsonObject;
}

function cachedBody(value: Prisma.JsonValue): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Corrupt idempotency response");
  return value;
}

// Handler side effects and cached response commit together; never send a success before COMMIT.
export function idempotentMutation(
  handler: (request: Request, tx: Prisma.TransactionClient) => Promise<MutationResult>,
  principal: (request: Request) => string | undefined = (request) => request.userId,
  prepare?: (request: Request) => Promise<void>,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const supplied = request.header("idempotency-key");
      if (!supplied || !/^[a-zA-Z0-9:_-]{8,200}$/.test(supplied)) {
        throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Supply an Idempotency-Key (8-200 letters, digits, : _ or -)");
      }
      const owner = principal(request);
      if (!owner) throw new AppError(401, "UNAUTHORIZED", "Authenticate before using idempotency");
      const key = requestHash([owner, request.method, request.originalUrl, supplied]);
      const hash = requestHash(request.body);
      if (prepare) {
        // A committed replay must not depend on current partner availability or current prices.
        const replay = await serializable(async (tx) => {
          const existing = await tx.idempotencyRecord.findUnique({ where: { key } });
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
          if (!clock) throw new Error("Database clock unavailable");
          if (!existing || existing.expiresAt <= clock.now) return null;
          if (existing.requestHash !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used with a different request");
          return { status: existing.statusCode, body: cachedBody(existing.response) };
        });
        if (replay) {
          response.status(replay.status).json(replay.body);
          return;
        }
        await prepare(request);
      }
      const run = async (): Promise<MutationResult> => serializable(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const existing = await tx.idempotencyRecord.findUnique({ where: { key } });
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
        if (!clock) throw new Error("Database clock unavailable");
        const { now } = clock;
        if (existing && existing.expiresAt > now) {
          if (existing.requestHash !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used with a different request");
          return { status: existing.statusCode, body: cachedBody(existing.response) };
        }
        if (existing) await tx.idempotencyRecord.delete({ where: { key } });
        const result = await handler(request, tx);
        await tx.idempotencyRecord.create({
          data: { key, requestHash: hash, response: result.body, statusCode: result.status,
            expiresAt: new Date(now.getTime() + 86_400_000) },
        });
        return result;
      });
      let result: MutationResult;
      try { result = await run(); }
      catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (!existing || existing.expiresAt <= new Date()) throw error;
        if (existing.requestHash !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used with a different request");
        result = { status: existing.statusCode, body: cachedBody(existing.response) };
      }
      response.status(result.status).json(result.body);
    } catch (error) { next(error); }
  };
}
