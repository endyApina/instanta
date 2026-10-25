import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const adapter = new PrismaPg({
  connectionString,
  connectionTimeoutMillis: 5_000,
  max: Number(process.env.DB_POOL_MAX ?? "10"),
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
});

if (!Number.isInteger(Number(process.env.DB_POOL_MAX ?? "10")) || Number(process.env.DB_POOL_MAX ?? "10") < 1) {
  throw new Error("DB_POOL_MAX must be a positive integer");
}

export const prisma = new PrismaClient({
  adapter,
  transactionOptions: { maxWait: 5_000, timeout: 15_000 },
});
