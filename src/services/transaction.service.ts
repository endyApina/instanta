import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";

export function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const adapter = error.meta?.driverAdapterError;
  const cause = adapter && typeof adapter === "object" && "cause" in adapter ? adapter.cause : undefined;
  // Prisma 7's pg adapter wraps SQLSTATE in a structured DriverAdapterError.
  const sqlState = cause && typeof cause === "object" && "originalCode" in cause ? cause.originalCode : error.meta?.code;
  return sqlState === "40001" || sqlState === "40P01";
}

export async function serializable<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  db: PrismaClient = prisma,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000, timeout: 15_000,
      });
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt >= 3) throw new AppError(409, "CONCURRENT_UPDATE", "Account is busy. Retry with the same Idempotency-Key.");
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

export async function assertWritable(tx: Prisma.TransactionClient): Promise<void> {
  // The DB switch can be changed without restarting replicas. Row lock orders it against postings.
  const controls = await tx.$queryRaw<{ readOnly: boolean }[]>`
    SELECT "readOnly" FROM "SystemControl" WHERE id = 'global' FOR SHARE
  `;
  if (controls.length !== 1) {
    throw new AppError(503, "SYSTEM_CONTROL_UNAVAILABLE", "Money movement is paused until the system control is restored");
  }
  if (process.env.SYSTEM_READ_ONLY_MODE === "true" || controls[0]?.readOnly) {
    throw new AppError(503, "SYSTEM_READ_ONLY", "Money movement and trading are temporarily paused");
  }
}
