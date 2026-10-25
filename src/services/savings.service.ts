import { AccountType, LedgerSide, Prisma, SavingsGoalStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";
import { createJournalEntryInTransaction } from "./ledger.service";
import { assertWritable, serializable } from "./transaction.service";
import { moneyAmount } from "../domain/money";
import { isDemoMode } from "../config/demo";
import { demoSavingsTransfer } from "./demoMode.service";

interface CreateGoalInput {
  userId: string;
  name: string;
  targetAmount: string;
  initialAmount: string;
  autoSweep: boolean;
  lockUntil?: Date;
  endDate?: Date;
}

export async function createSavingsGoal(input: CreateGoalInput, transaction?: Prisma.TransactionClient): Promise<{ id: string; status: SavingsGoalStatus }> {
  const target = new Prisma.Decimal(moneyAmount(input.targetAmount).toFixed(2));
  const initial = new Prisma.Decimal(moneyAmount(input.initialAmount, true).toFixed(2));
  if (!target.isFinite() || target.lte(0) || target.decimalPlaces() > 2) {
    throw new AppError(400, "INVALID_TARGET_AMOUNT", "Target amount must be positive and have at most 2 decimal places");
  }
  if (!initial.isFinite() || initial.lt(0) || initial.decimalPlaces() > 2 || initial.gt(target)) {
    throw new AppError(400, "INVALID_INITIAL_AMOUNT", "Initial amount must be non-negative and no greater than the target");
  }
  if (input.endDate && input.lockUntil && input.endDate < input.lockUntil) {
    throw new AppError(400, "INVALID_GOAL_DATES", "Goal end date cannot be before its lock date");
  }

  const work = async (tx: Prisma.TransactionClient) => {
    await assertWritable(tx);
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() as now`;
    if (!clock) throw new Error("Database clock unavailable");
    if ((input.lockUntil && input.lockUntil <= clock.now) || (input.endDate && input.endDate <= clock.now)) {
      throw new AppError(400, "INVALID_GOAL_DATES", "Goal dates must be in the future according to the database UTC clock");
    }
    if (isDemoMode()) await demoSavingsTransfer(tx, input.userId, initial.toFixed(2));
    const wallet = await tx.wallet.findUnique({
      where: { userId: input.userId },
      include: { ledgerAccount: true },
    });
    if (!wallet || wallet.status !== "ACTIVE" || !wallet.ledgerAccount) {
      throw new AppError(404, "ACTIVE_WALLET_NOT_FOUND", "An active wallet was not found");
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
        status: input.lockUntil ? SavingsGoalStatus.LOCKED : SavingsGoalStatus.ACTIVE,
      },
    });
    const goalAccount = await tx.ledgerAccount.create({
      data: {
        code: `USER_GOAL_SAVINGS_LIABILITY:${goal.id}`,
        name: `Savings Goal Liability: ${input.name}`,
        accountType: AccountType.LIABILITY,
        normalBalance: LedgerSide.CREDIT,
        userId: input.userId,
        savingsGoalId: goal.id,
      },
    });

    if (initial.gt(0)) {
      await createJournalEntryInTransaction(
        tx,
        [
          { ledgerAccountId: wallet.ledgerAccount.id, side: LedgerSide.DEBIT, amount: initial.toFixed(2) },
          { ledgerAccountId: goalAccount.id, side: LedgerSide.CREDIT, amount: initial.toFixed(2) },
        ],
        { description: "Lock funds to savings goal" },
      );
    }
    return { id: goal.id, status: goal.status };
  };
  return transaction ? work(transaction) : serializable(work);
}
