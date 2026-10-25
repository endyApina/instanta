import { AccountType, LedgerSide, Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";
import type { TransactionInput } from "../types";
import { assertWritable, serializable } from "./transaction.service";
import { requestHash } from "../domain/request-hash";
import { moneyAmount } from "../domain/money";

type DbTransaction = Prisma.TransactionClient;
Prisma.Decimal.set({ precision: 48 });

interface JournalOptions {
  description: string;
  currency?: string;
  idempotencyKey?: string;
  externalReference?: string;
}

function parseAmount(value: string): Prisma.Decimal {
  return new Prisma.Decimal(moneyAmount(value).toFixed(2));
}

/**
 * Post a balanced journal and update cached normal-balance account balances in
 * the same serializable transaction. A ledger balance is debit-normal for
 * assets/expenses and credit-normal for liabilities/equity/revenue.
 */
export async function createJournalEntry(
  entries: TransactionInput[],
  options: JournalOptions,
): Promise<{ id: string }> {
  return serializable((tx) => createJournalEntryInTransaction(tx, entries, options));
}

export async function createJournalEntryInTransaction(
  tx: DbTransaction,
  entries: TransactionInput[],
  options: JournalOptions,
): Promise<{ id: string }> {
  await assertWritable(tx);
  if (entries.length < 2) {
    throw new AppError(400, "INVALID_JOURNAL", "A journal entry requires at least two transaction lines");
  }

  if (entries.some((entry) => ![LedgerSide.DEBIT, LedgerSide.CREDIT].includes(entry.side))) {
    throw new AppError(400, "INVALID_LEDGER_SIDE", "Ledger sides must be DEBIT or CREDIT");
  }
  const parsed = entries.map((entry) => ({ ...entry, decimalAmount: parseAmount(entry.amount) }));
  const debits = parsed
    .filter((entry) => entry.side === LedgerSide.DEBIT)
    .reduce((sum, entry) => sum.plus(entry.decimalAmount), new Prisma.Decimal(0));
  const credits = parsed
    .filter((entry) => entry.side === LedgerSide.CREDIT)
    .reduce((sum, entry) => sum.plus(entry.decimalAmount), new Prisma.Decimal(0));
  if (debits.isZero() || !debits.equals(credits)) {
    throw new AppError(422, "UNBALANCED_JOURNAL", "Total debits must equal total credits");
  }

  const currency = options.currency ?? "NGN";
  const hash = requestHash({ entries, options });
  if (options.idempotencyKey) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${options.idempotencyKey}, 1))`;
    const existing = await tx.journalEntry.findUnique({ where: { idempotencyKey: options.idempotencyKey } });
    if (existing) {
      if (existing.requestHash !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Journal key reused for different entries");
      return { id: existing.id };
    }
  }
  const accountIds = [...new Set(parsed.map((entry) => entry.ledgerAccountId))].sort();
  // Lock wallets before accounts, always in deterministic order to avoid deadlock cycles.
  const wallets = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT w.id, w.status FROM "Wallet" w JOIN "LedgerAccount" a ON a."walletId" = w.id
    WHERE a.id IN (${Prisma.join(accountIds)}) ORDER BY w.id FOR UPDATE OF w
  `;
  if (wallets.some((wallet) => wallet.status !== "ACTIVE")) {
    throw new AppError(409, "WALLET_INACTIVE", "Financial postings require active wallets");
  }
  await tx.$queryRaw`
    SELECT id FROM "LedgerAccount" WHERE id IN (${Prisma.join(accountIds)}) ORDER BY id FOR UPDATE
  `;
  const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: accountIds } } });
  if (accounts.length !== accountIds.length) {
    throw new AppError(404, "LEDGER_ACCOUNT_NOT_FOUND", "One or more ledger accounts do not exist");
  }

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const netChanges = new Map<string, Prisma.Decimal>();
  for (const entry of parsed) {
    const account = accountById.get(entry.ledgerAccountId);
    if (!account || account.currency !== currency) {
      throw new AppError(400, "CURRENCY_MISMATCH", "Every ledger account must use the journal currency");
    }
    const increasesNormalBalance =
      (account.normalBalance === LedgerSide.DEBIT && entry.side === LedgerSide.DEBIT) ||
      (account.normalBalance === LedgerSide.CREDIT && entry.side === LedgerSide.CREDIT);
    const delta = increasesNormalBalance ? entry.decimalAmount : entry.decimalAmount.negated();
    netChanges.set(
      account.id,
      (netChanges.get(account.id) ?? new Prisma.Decimal(0)).plus(delta),
    );
  }

  for (const [accountId, delta] of netChanges) {
    const account = accountById.get(accountId)!;
    if (delta.lt(0) && account.savingsGoalId) {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "SavingsGoal" WHERE id = ${account.savingsGoalId}
        AND "lockUntil" > clock_timestamp() FOR UPDATE
      `;
      if (locked.length) throw new AppError(409, "GOAL_LOCKED", "Savings cannot leave this goal before the database lock expiry");
    }
    if (account.balance.plus(delta).lt(0)) {
      throw new AppError(409, "INSUFFICIENT_LEDGER_BALANCE", `Account ${account.code} has insufficient balance`);
    }
  }

  const journal = await tx.journalEntry.create({
    data: {
      description: options.description,
      currency,
      idempotencyKey: options.idempotencyKey,
      externalReference: options.externalReference,
      requestHash: hash,
      transactions: {
        create: parsed.map((entry) => ({
          ledgerAccountId: entry.ledgerAccountId,
          side: entry.side,
          amount: entry.decimalAmount,
          currency,
          description: entry.description,
        })),
      },
    },
    select: { id: true },
  });

  for (const [accountId, delta] of netChanges) {
    await tx.ledgerAccount.update({
      where: { id: accountId },
      data: { balance: { increment: delta } },
    });
  }
  return journal;
}

export async function provisionLedgerAccounts(
  tx: DbTransaction,
  userId: string,
  walletId: string,
): Promise<void> {
  await ensureSystemAccounts(tx);
  await tx.ledgerAccount.create({
    data: {
      code: `USER_WALLET_LIABILITY:${userId}`,
      name: "User Wallet Liability",
      accountType: AccountType.LIABILITY,
      normalBalance: LedgerSide.CREDIT,
      userId,
      walletId,
    },
  });
}

async function ensureSystemAccounts(tx: DbTransaction): Promise<void> {
  const accounts = [
    {
      code: "BAAS_SETTLEMENT_ASSET",
      name: "BaaS Settlement Asset",
      accountType: AccountType.ASSET,
      normalBalance: LedgerSide.DEBIT,
    },
    {
      code: "INTEREST_EXPENSE",
      name: "Interest Expense",
      accountType: AccountType.EXPENSE,
      normalBalance: LedgerSide.DEBIT,
    },
  ] as const;
  for (const account of accounts) {
    await tx.ledgerAccount.upsert({
      where: { code: account.code },
      create: { ...account, isSystemAccount: true },
      update: {},
    });
  }
}

export async function createDepositJournal(
  tx: DbTransaction,
  walletAccountId: string,
  amount: string,
  eventId: string,
  reference: string,
): Promise<{ id: string }> {
  const settlement = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "BAAS_SETTLEMENT_ASSET" } });
  return createJournalEntryInTransaction(
    tx,
    [
      { ledgerAccountId: settlement.id, side: LedgerSide.DEBIT, amount },
      { ledgerAccountId: walletAccountId, side: LedgerSide.CREDIT, amount },
    ],
    { description: "BaaS user deposit", idempotencyKey: `baas:${eventId}`, externalReference: reference },
  );
}

export async function createWithdrawalJournal(
  tx: DbTransaction,
  walletAccountId: string,
  amount: string,
  eventId: string,
  reference: string,
): Promise<{ id: string }> {
  const settlement = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "BAAS_SETTLEMENT_ASSET" } });
  return createJournalEntryInTransaction(
    tx,
    [
      { ledgerAccountId: walletAccountId, side: LedgerSide.DEBIT, amount },
      { ledgerAccountId: settlement.id, side: LedgerSide.CREDIT, amount },
    ],
    { description: "BaaS user withdrawal", idempotencyKey: `baas:${eventId}`, externalReference: reference },
  );
}

export async function accrueGoalInterest(
  db: PrismaClient,
  goalId: string,
  amount: string,
  idempotencyKey: string,
): Promise<{ id: string }> {
  if (!idempotencyKey.trim()) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Interest accrual requires a stable idempotency key");
  const parsedAmount = parseAmount(amount);
  return serializable(async (tx) => {
    // Serialize both the journal and its accrued-yield counter, including retries after uncertain commits.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 1))`;
    const previous = await tx.journalEntry.findUnique({ where: { idempotencyKey } });
    const goal = await tx.savingsGoal.findUnique({
      where: { id: goalId },
      include: { ledgerAccount: true },
    });
    if (!goal?.ledgerAccount) {
      throw new AppError(404, "SAVINGS_GOAL_NOT_FOUND", "Savings goal or its ledger account was not found");
    }
    const expense = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "INTEREST_EXPENSE" } });
    const journal = await createJournalEntryInTransaction(
      tx,
      [
        { ledgerAccountId: expense.id, side: LedgerSide.DEBIT, amount: parsedAmount.toFixed(2) },
        { ledgerAccountId: goal.ledgerAccount.id, side: LedgerSide.CREDIT, amount: parsedAmount.toFixed(2) },
      ],
      { description: "Savings goal interest accrual", idempotencyKey },
    );
    // createJournalEntryInTransaction verifies the payload hash even when the journal already exists.
    if (previous) return journal;
    await tx.savingsGoal.update({
      where: { id: goalId },
      data: { yieldAccrued: { increment: parsedAmount } },
    });
    return journal;
  }, db);
}
