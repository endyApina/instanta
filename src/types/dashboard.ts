export interface GoalSummary {
  id: string;
  name: string;
  targetAmount: string;
  lockedAmount: string;
  yieldAccrued: string;
  balance: string;
  autoSweep: boolean;
  status: string;
  lockUntil: string | null;
  endDate: string | null;
}

export interface ActivitySummary {
  id: string;
  journalEntryId: string;
  description: string;
  accountName: string;
  side: "DEBIT" | "CREDIT";
  amount: string;
  createdAt: string;
}

export interface DashboardData {
  partnerMode: "MOCK" | "LIVE";
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    kycLevel: string;
    kycStatus: string;
    bvnLastFour: string | null;
    ninLastFour: string | null;
    maxTolerableLoss: string | null;
    targetReturn: string | null;
    timeHorizonMonths: number | null;
  };
  wallet: {
    status: string;
    currency: string;
    balance: string;
    virtualAccountNumber: string | null;
    virtualAccountName: string | null;
    virtualAccountBank: string | null;
  } | null;
  goals: GoalSummary[];
  activity: ActivitySummary[];
}
