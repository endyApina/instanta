import type { DashboardData } from "../../src/types/dashboard";

export interface GoalInput {
  name: string;
  targetAmount: string;
  initialAmount: string;
  autoSweep: boolean;
  lockUntil?: string;
  endDate?: string;
}

export function createDemoData(): DashboardData {
  return {
    partnerMode: "MOCK",
    user: {
      id: "demo", firstName: "Amara", lastName: "Okafor", email: "amara@example.com",
      kycLevel: "TIER_2", kycStatus: "VERIFIED", bvnLastFour: "1234", ninLastFour: null,
      maxTolerableLoss: "0", targetReturn: "0", timeHorizonMonths: 0,
    },
    wallet: {
      balance: "0.00", status: "ACTIVE", currency: "NGN",
      virtualAccountNumber: null, virtualAccountName: null, virtualAccountBank: null,
    },
    goals: [],
    activity: [],
  };
}

function minorUnits(amount: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error("Enter an amount with at most two decimal places.");
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function amountString(amount: bigint): string {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
}

export function addDemoGoal(data: DashboardData, input: GoalInput): DashboardData {
  if (!data.wallet) throw new Error("A wallet is required.");
  const initial = minorUnits(input.initialAmount);
  const target = minorUnits(input.targetAmount);
  const balance = minorUnits(data.wallet.balance);
  if (target <= 0n || initial > target) throw new Error("The target must be positive and at least the initial amount.");
  if (initial > balance) throw new Error("Insufficient wallet balance. Reduce the initial contribution.");
  if (input.lockUntil && input.endDate && input.lockUntil > input.endDate) {
    throw new Error("The goal end date cannot be before the lock date.");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const journalEntryId = `demo-${id}`;
  return {
    ...data,
    wallet: { ...data.wallet, balance: amountString(balance - initial) },
    goals: [{
      id, ...input, targetAmount: amountString(target), lockedAmount: amountString(initial),
      balance: amountString(initial), yieldAccrued: "0.00",
      status: input.lockUntil ? "LOCKED" : "ACTIVE",
      lockUntil: input.lockUntil ?? null, endDate: input.endDate ?? null,
    }, ...data.goals],
    activity: initial > 0n ? [
      { id: `${id}-wallet`, journalEntryId, description: "Demo goal funding", accountName: "Wallet", side: "DEBIT", amount: amountString(initial), createdAt: now },
      { id: `${id}-goal`, journalEntryId, description: "Demo goal funding", accountName: input.name, side: "CREDIT", amount: amountString(initial), createdAt: now },
      ...data.activity,
    ] : data.activity,
  };
}
