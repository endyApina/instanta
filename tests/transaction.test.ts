import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { isRetryableTransactionError } from "../src/services/transaction.service";

test("transaction retries recognize Prisma 7 pg-wrapped serialization and deadlock errors only", () => {
  for (const sqlState of ["40001", "40P01"]) {
    assert.equal(isRetryableTransactionError(new Prisma.PrismaClientKnownRequestError("conflict", {
      code: "P2010", clientVersion: "7.10.1",
      meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: sqlState } } },
    })), true);
    assert.equal(isRetryableTransactionError(new Prisma.PrismaClientKnownRequestError("conflict", {
      code: "P2010", clientVersion: "7.10.1", meta: { code: sqlState },
    })), true);
  }
  assert.equal(isRetryableTransactionError(new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "7.10.1" })), true);
  assert.equal(isRetryableTransactionError(new Prisma.PrismaClientKnownRequestError("constraint", {
    code: "P2010", clientVersion: "7.10.1", meta: { driverAdapterError: { cause: { originalCode: "23514" } } },
  })), false);
  assert.equal(isRetryableTransactionError(new Error("40001")), false);
});
