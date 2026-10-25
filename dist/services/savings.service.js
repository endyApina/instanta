"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSavingsGoal = createSavingsGoal;
const client_1 = require("@prisma/client");
const app_error_1 = require("../errors/app-error");
const ledger_service_1 = require("./ledger.service");
const transaction_service_1 = require("./transaction.service");
const money_1 = require("../domain/money");
const demo_1 = require("../config/demo");
const demoMode_service_1 = require("./demoMode.service");
async function createSavingsGoal(input, transaction) {
    const target = new client_1.Prisma.Decimal((0, money_1.moneyAmount)(input.targetAmount).toFixed(2));
    const initial = new client_1.Prisma.Decimal((0, money_1.moneyAmount)(input.initialAmount, true).toFixed(2));
    if (!target.isFinite() || target.lte(0) || target.decimalPlaces() > 2) {
        throw new app_error_1.AppError(400, "INVALID_TARGET_AMOUNT", "Target amount must be positive and have at most 2 decimal places");
    }
    if (!initial.isFinite() || initial.lt(0) || initial.decimalPlaces() > 2 || initial.gt(target)) {
        throw new app_error_1.AppError(400, "INVALID_INITIAL_AMOUNT", "Initial amount must be non-negative and no greater than the target");
    }
    if (input.endDate && input.lockUntil && input.endDate < input.lockUntil) {
        throw new app_error_1.AppError(400, "INVALID_GOAL_DATES", "Goal end date cannot be before its lock date");
    }
    const work = async (tx) => {
        await (0, transaction_service_1.assertWritable)(tx);
        const [clock] = await tx.$queryRaw `SELECT clock_timestamp() as now`;
        if (!clock)
            throw new Error("Database clock unavailable");
        if ((input.lockUntil && input.lockUntil <= clock.now) || (input.endDate && input.endDate <= clock.now)) {
            throw new app_error_1.AppError(400, "INVALID_GOAL_DATES", "Goal dates must be in the future according to the database UTC clock");
        }
        if ((0, demo_1.isDemoMode)())
            await (0, demoMode_service_1.demoSavingsTransfer)(tx, input.userId, initial.toFixed(2));
        const wallet = await tx.wallet.findUnique({
            where: { userId: input.userId },
            include: { ledgerAccount: true },
        });
        if (!wallet || wallet.status !== "ACTIVE" || !wallet.ledgerAccount) {
            throw new app_error_1.AppError(404, "ACTIVE_WALLET_NOT_FOUND", "An active wallet was not found");
        }
        const goal = await tx.savingsGoal.create({
            data: {
                userId: input.userId,
                name: input.name,
                targetAmount: target,
                lockedAmount: initial,
                autoSweep: input.autoSweep,
                lockUntil: input.lockUntil,
                endDate: input.endDate,
                status: input.lockUntil ? client_1.SavingsGoalStatus.LOCKED : client_1.SavingsGoalStatus.ACTIVE,
            },
        });
        const goalAccount = await tx.ledgerAccount.create({
            data: {
                code: `USER_GOAL_SAVINGS_LIABILITY:${goal.id}`,
                name: `Savings Goal Liability: ${input.name}`,
                accountType: client_1.AccountType.LIABILITY,
                normalBalance: client_1.LedgerSide.CREDIT,
                userId: input.userId,
                savingsGoalId: goal.id,
            },
        });
        if (initial.gt(0)) {
            await (0, ledger_service_1.createJournalEntryInTransaction)(tx, [
                { ledgerAccountId: wallet.ledgerAccount.id, side: client_1.LedgerSide.DEBIT, amount: initial.toFixed(2) },
                { ledgerAccountId: goalAccount.id, side: client_1.LedgerSide.CREDIT, amount: initial.toFixed(2) },
            ], { description: "Lock funds to savings goal" });
        }
        return { id: goal.id, status: goal.status };
    };
    return transaction ? work(transaction) : (0, transaction_service_1.serializable)(work);
}
