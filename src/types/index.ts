import type { LedgerSide } from "@prisma/client";

export interface RiskProfile {
  /** Fraction in the range 0..1; e.g. 0.1 means a 10% maximum loss. */
  maxTolerableLoss: number;
  /** Annual expected return as a fraction; e.g. 0.12 means 12%. */
  targetReturn: number;
  timeHorizonMonths: number;
}

export interface OrderRequest {
  userId: string;
  goalId?: string;
  fundManagerId: string;
  assetClass: string;
  amount: string;
  currency: "NGN";
  idempotencyKey: string;
}

export interface Allocation {
  [assetClass: string]: number;
}

export interface PortfolioHolding {
  assetClass: string;
  marketValue: number;
}

export interface Portfolio {
  totalValue: number;
  holdings: PortfolioHolding[];
}

export interface SuggestedTrade {
  assetClass: string;
  side: "BUY" | "SELL";
  amount: number;
  driftPercentagePoints: number;
}

export interface RebalanceSignal {
  shouldRebalance: boolean;
  thresholdPercentagePoints: number;
  targetVsActual: Record<string, { target: number; actual: number; drift: number }>;
  suggestedTrades: SuggestedTrade[];
}

export type BaaSEventType = "DEPOSIT" | "WITHDRAWAL";

export interface BaaSWebhookPayload {
  eventId: string;
  eventType: BaaSEventType;
  virtualAccountNumber: string;
  amount: string;
  currency: "NGN";
  reference: string;
  occurredAt: string;
}

export interface TransactionInput {
  ledgerAccountId: string;
  side: LedgerSide;
  amount: string;
  description?: string;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
  };
}
