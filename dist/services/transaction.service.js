"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRetryableTransactionError = isRetryableTransactionError;
exports.serializable = serializable;
exports.assertWritable = assertWritable;
const client_1 = require("@prisma/client");
const prisma_1 = require("../config/prisma");
const app_error_1 = require("../errors/app-error");
function isRetryableTransactionError(error) {
    if (!(error instanceof client_1.Prisma.PrismaClientKnownRequestError))
        return false;
    if (error.code === "P2034")
        return true;
    if (error.code !== "P2010")
        return false;
    const adapter = error.meta?.driverAdapterError;
    const cause = adapter && typeof adapter === "object" && "cause" in adapter ? adapter.cause : undefined;
    // Prisma 7's pg adapter wraps SQLSTATE in a structured DriverAdapterError.
    const sqlState = cause && typeof cause === "object" && "originalCode" in cause ? cause.originalCode : error.meta?.code;
    return sqlState === "40001" || sqlState === "40P01";
}
async function serializable(work, db = prisma_1.prisma) {
    for (let attempt = 0;; attempt++) {
        try {
            return await db.$transaction(work, {
                isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable,
                maxWait: 5_000, timeout: 15_000,
            });
        }
        catch (error) {
            if (!isRetryableTransactionError(error))
                throw error;
            if (attempt >= 3)
                throw new app_error_1.AppError(409, "CONCURRENT_UPDATE", "Account is busy. Retry with the same Idempotency-Key.");
            await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
    }
}
async function assertWritable(tx) {
    // The DB switch can be changed without restarting replicas. Row lock orders it against postings.
    const controls = await tx.$queryRaw `
    SELECT "readOnly" FROM "SystemControl" WHERE id = 'global' FOR SHARE
  `;
    if (controls.length !== 1) {
        throw new app_error_1.AppError(503, "SYSTEM_CONTROL_UNAVAILABLE", "Money movement is paused until the system control is restored");
    }
    if (process.env.SYSTEM_READ_ONLY_MODE === "true" || controls[0]?.readOnly) {
        throw new app_error_1.AppError(503, "SYSTEM_READ_ONLY", "Money movement and trading are temporarily paused");
    }
}
