"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJournalEntry = createJournalEntry;
exports.createJournalEntryInTransaction = createJournalEntryInTransaction;
exports.provisionLedgerAccounts = provisionLedgerAccounts;
exports.createDepositJournal = createDepositJournal;
exports.createWithdrawalJournal = createWithdrawalJournal;
exports.accrueGoalInterest = accrueGoalInterest;
const client_1 = require("@prisma/client");
const app_error_1 = require("../errors/app-error");
const transaction_service_1 = require("./transaction.service");
const request_hash_1 = require("../domain/request-hash");
const money_1 = require("../domain/money");
client_1.Prisma.Decimal.set({ precision: 48 });
function parseAmount(value) {
    return new client_1.Prisma.Decimal((0, money_1.moneyAmount)(value).toFixed(2));
}
/**
 * Post a balanced journal and update cached normal-balance account balances in
 * the same serializable transaction. A ledger balance is debit-normal for
 * assets/expenses and credit-normal for liabilities/equity/revenue.
 */
async function createJournalEntry(entries, options) {
    return (0, transaction_service_1.serializable)((tx) => createJournalEntryInTransaction(tx, entries, options));
}
async function createJournalEntryInTransaction(tx, entries, options) {
    await (0, transaction_service_1.assertWritable)(tx);
    if (entries.length < 2) {
        throw new app_error_1.AppError(400, "INVALID_JOURNAL", "A journal entry requires at least two transaction lines");
    }
    if (entries.some((entry) => ![client_1.LedgerSide.DEBIT, client_1.LedgerSide.CREDIT].includes(entry.side))) {
        throw new app_error_1.AppError(400, "INVALID_LEDGER_SIDE", "Ledger sides must be DEBIT or CREDIT");
    }
    const parsed = entries.map((entry) => ({ ...entry, decimalAmount: parseAmount(entry.amount) }));
    const debits = parsed
        .filter((entry) => entry.side === client_1.LedgerSide.DEBIT)
        .reduce((sum, entry) => sum.plus(entry.decimalAmount), new client_1.Prisma.Decimal(0));
    const credits = parsed
        .filter((entry) => entry.side === client_1.LedgerSide.CREDIT)
        .reduce((sum, entry) => sum.plus(entry.decimalAmount), new client_1.Prisma.Decimal(0));
    if (debits.isZero() || !debits.equals(credits)) {
        throw new app_error_1.AppError(422, "UNBALANCED_JOURNAL", "Total debits must equal total credits");
    }
    const currency = options.currency ?? "NGN";
    const hash = (0, request_hash_1.requestHash)({ entries, options });
    if (options.idempotencyKey) {
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${options.idempotencyKey}, 1))`;
        const existing = await tx.journalEntry.findUnique({ where: { idempotencyKey: options.idempotencyKey } });
        if (existing) {
            if (existing.requestHash !== hash)
                throw new app_error_1.AppError(409, "IDEMPOTENCY_CONFLICT", "Journal key reused for different entries");
            return { id: existing.id };
        }
    }
    const accountIds = [...new Set(parsed.map((entry) => entry.ledgerAccountId))].sort();
    // Lock wallets before accounts, always in deterministic order to avoid deadlock cycles.
    const wallets = await tx.$queryRaw `
    SELECT w.id, w.status FROM "Wallet" w JOIN "LedgerAccount" a ON a."walletId" = w.id
    WHERE a.id IN (${client_1.Prisma.join(accountIds)}) ORDER BY w.id FOR UPDATE OF w
  `;
    if (wallets.some((wallet) => wallet.status !== "ACTIVE")) {
        throw new app_error_1.AppError(409, "WALLET_INACTIVE", "Financial postings require active wallets");
    }
    await tx.$queryRaw `
    SELECT id FROM "LedgerAccount" WHERE id IN (${client_1.Prisma.join(accountIds)}) ORDER BY id FOR UPDATE
  `;
    const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: accountIds } } });
    if (accounts.length !== accountIds.length) {
        throw new app_error_1.AppError(404, "LEDGER_ACCOUNT_NOT_FOUND", "One or more ledger accounts do not exist");
    }
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const netChanges = new Map();
    for (const entry of parsed) {
        const account = accountById.get(entry.ledgerAccountId);
        if (!account || account.currency !== currency) {
            throw new app_error_1.AppError(400, "CURRENCY_MISMATCH", "Every ledger account must use the journal currency");
        }
        const increasesNormalBalance = (account.normalBalance === client_1.LedgerSide.DEBIT && entry.side === client_1.LedgerSide.DEBIT) ||
            (account.normalBalance === client_1.LedgerSide.CREDIT && entry.side === client_1.LedgerSide.CREDIT);
        const delta = increasesNormalBalance ? entry.decimalAmount : entry.decimalAmount.negated();
        netChanges.set(account.id, (netChanges.get(account.id) ?? new client_1.Prisma.Decimal(0)).plus(delta));
    }
    for (const [accountId, delta] of netChanges) {
        const account = accountById.get(accountId);
        if (delta.lt(0) && account.savingsGoalId) {
            const locked = await tx.$queryRaw `
        SELECT id FROM "SavingsGoal" WHERE id = ${account.savingsGoalId}
        AND "lockUntil" > clock_timestamp() FOR UPDATE
      `;
            if (locked.length)
                throw new app_error_1.AppError(409, "GOAL_LOCKED", "Savings cannot leave this goal before the database lock expiry");
        }
        if (account.balance.plus(delta).lt(0)) {
            throw new app_error_1.AppError(409, "INSUFFICIENT_LEDGER_BALANCE", `Account ${account.code} has insufficient balance`);
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
async function provisionLedgerAccounts(tx, userId, walletId) {
    await ensureSystemAccounts(tx);
    await tx.ledgerAccount.create({
        data: {
            code: `USER_WALLET_LIABILITY:${userId}`,
            name: "User Wallet Liability",
            accountType: client_1.AccountType.LIABILITY,
            normalBalance: client_1.LedgerSide.CREDIT,
            userId,
            walletId,
        },
    });
}
async function ensureSystemAccounts(tx) {
    const accounts = [
        {
            code: "BAAS_SETTLEMENT_ASSET",
            name: "BaaS Settlement Asset",
            accountType: client_1.AccountType.ASSET,
            normalBalance: client_1.LedgerSide.DEBIT,
        },
        {
            code: "INTEREST_EXPENSE",
            name: "Interest Expense",
            accountType: client_1.AccountType.EXPENSE,
            normalBalance: client_1.LedgerSide.DEBIT,
        },
    ];
    for (const account of accounts) {
        await tx.ledgerAccount.upsert({
            where: { code: account.code },
            create: { ...account, isSystemAccount: true },
            update: {},
        });
    }
}
async function createDepositJournal(tx, walletAccountId, amount, eventId, reference) {
    const settlement = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "BAAS_SETTLEMENT_ASSET" } });
    return createJournalEntryInTransaction(tx, [
        { ledgerAccountId: settlement.id, side: client_1.LedgerSide.DEBIT, amount },
        { ledgerAccountId: walletAccountId, side: client_1.LedgerSide.CREDIT, amount },
    ], { description: "BaaS user deposit", idempotencyKey: `baas:${eventId}`, externalReference: reference });
}
async function createWithdrawalJournal(tx, walletAccountId, amount, eventId, reference) {
    const settlement = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "BAAS_SETTLEMENT_ASSET" } });
    return createJournalEntryInTransaction(tx, [
        { ledgerAccountId: walletAccountId, side: client_1.LedgerSide.DEBIT, amount },
        { ledgerAccountId: settlement.id, side: client_1.LedgerSide.CREDIT, amount },
    ], { description: "BaaS user withdrawal", idempotencyKey: `baas:${eventId}`, externalReference: reference });
}
async function accrueGoalInterest(db, goalId, amount, idempotencyKey) {
    if (!idempotencyKey.trim())
        throw new app_error_1.AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Interest accrual requires a stable idempotency key");
    const parsedAmount = parseAmount(amount);
    return (0, transaction_service_1.serializable)(async (tx) => {
        // Serialize both the journal and its accrued-yield counter, including retries after uncertain commits.
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 1))`;
        const previous = await tx.journalEntry.findUnique({ where: { idempotencyKey } });
        const goal = await tx.savingsGoal.findUnique({
            where: { id: goalId },
            include: { ledgerAccount: true },
        });
        if (!goal?.ledgerAccount) {
            throw new app_error_1.AppError(404, "SAVINGS_GOAL_NOT_FOUND", "Savings goal or its ledger account was not found");
        }
        const expense = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: "INTEREST_EXPENSE" } });
        const journal = await createJournalEntryInTransaction(tx, [
            { ledgerAccountId: expense.id, side: client_1.LedgerSide.DEBIT, amount: parsedAmount.toFixed(2) },
            { ledgerAccountId: goal.ledgerAccount.id, side: client_1.LedgerSide.CREDIT, amount: parsedAmount.toFixed(2) },
        ], { description: "Savings goal interest accrual", idempotencyKey });
        // createJournalEntryInTransaction verifies the payload hash even when the journal already exists.
        if (previous)
            return journal;
        await tx.savingsGoal.update({
            where: { id: goalId },
            data: { yieldAccrued: { increment: parsedAmount } },
        });
        return journal;
    }, db);
}
