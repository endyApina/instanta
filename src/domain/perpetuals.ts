import { z } from "zod";
import { MoneyDecimal as D } from "./money";
import { AppError } from "../errors/app-error";

export const globalDecimal = z.string().regex(/^\d{1,18}(\.\d{1,8})?$/);
export const positiveGlobalDecimal = globalDecimal.refine((value) => new D(value).gt(0), "Value must be positive");
export const globalSymbol = z.string().min(2).max(64).regex(/^[A-Za-z0-9_.-]+$/);
export const globalAsset = z.enum(["NGN", "USD", "USDT", "USDC"]);
export const instrumentSchema = z.object({
  symbol: globalSymbol, kind: z.string(), mode: z.string(), baseAsset: z.string().min(1),
  quoteAsset: z.string().min(1), settlementCcy: z.string().min(1),
  tickSize: positiveGlobalDecimal, qtyStep: positiveGlobalDecimal, minQty: positiveGlobalDecimal,
  contractMultiplier: positiveGlobalDecimal, status: z.string(),
  minNotional: globalDecimal.optional(), maxOrderQty: positiveGlobalDecimal.optional(),
});
export type GlobalInstrument = z.infer<typeof instrumentSchema>;
export const globalInstrumentsSchema = z.object({
  simulated: z.boolean(), instruments: z.array(instrumentSchema).max(5000),
});
export const paperOrderSchema = z.object({
  symbol: globalSymbol, side: z.enum(["BUY", "SELL"]), qty: positiveGlobalDecimal,
  limitPrice: positiveGlobalDecimal, acknowledgeHighRisk: z.boolean().default(false),
});
export const riskScoreSchema = z.object({
  source: z.enum(["BAYESSHIELD_GATEWAY", "UNAVAILABLE"]), simulated: z.boolean(),
  lossProbability: z.number().finite().min(0).max(1).nullable(),
  winProbability: z.number().finite().min(0).max(1).nullable(),
  warning: z.string(), assessedAt: z.string().datetime(),
});
export type GlobalRiskScore = z.infer<typeof riskScoreSchema>;
export const globalEventSchema = z.object({
  region: z.enum(["LOCAL", "GLOBAL"]), provider: z.string(), simulated: z.boolean(),
  symbol: z.string(), channel: z.string(), receivedAt: z.string().datetime(), data: z.unknown(),
});
export type GlobalMarketEvent = z.infer<typeof globalEventSchema>;
export const globalSnapshotSchema = z.object({
  executionMode: z.literal("PAPER_ONLY"),
  balances: z.array(z.object({ asset: globalAsset, available: globalDecimal })),
  positions: z.array(z.object({ symbol: z.string(), asset: globalAsset, qty: globalDecimal, cost: globalDecimal })),
  orders: z.array(z.object({
    id: z.string(), symbol: z.string(), side: z.enum(["BUY", "SELL"]), qty: globalDecimal,
    price: globalDecimal, amount: globalDecimal, asset: globalAsset, createdAt: z.string(),
  })),
});

/** Conventional perpetuals do not acquire a loss cap from a stop-loss or a model probability. */
export function sizeLossBoundedPosition(input: {
  principal: string; maxLossFraction: string; unitPremium: string; fees: string; qtyStep: string;
}) {
  const principal = new D(positiveGlobalDecimal.parse(input.principal));
  const fraction = new D(globalDecimal.parse(input.maxLossFraction));
  const premium = new D(positiveGlobalDecimal.parse(input.unitPremium));
  const fees = new D(globalDecimal.parse(input.fees));
  const step = new D(positiveGlobalDecimal.parse(input.qtyStep));
  if (fraction.gt(1)) throw new AppError(400, "INVALID_RISK_BUDGET", "Loss fraction must be between zero and one");
  const budget = principal.mul(fraction).toDecimalPlaces(8, D.ROUND_DOWN);
  if (fees.gte(budget)) return { qty: "0", maximumLoss: "0", budget: budget.toFixed(8) };
  const qty = budget.minus(fees).div(premium).div(step).floor().mul(step);
  if (qty.isZero()) return { qty: "0", maximumLoss: "0", budget: budget.toFixed(8) };
  return { qty: qty.toFixed(8), maximumLoss: qty.mul(premium).plus(fees).toFixed(8, D.ROUND_UP), budget: budget.toFixed(8) };
}

export function mapSandboxOrder(instrument: GlobalInstrument, input: {
  symbol: string; side: "BUY" | "SELL"; qty: string; limitPrice: string;
}, clientUid: string, clOrdId: string) {
  const parsed = paperOrderSchema.parse(input);
  const qty = new D(parsed.qty);
  const price = new D(parsed.limitPrice);
  if (parsed.symbol !== instrument.symbol || !qty.mod(instrument.qtyStep).isZero()
    || !price.mod(instrument.tickSize).isZero() || qty.lt(instrument.minQty)
    || (instrument.maxOrderQty && qty.gt(instrument.maxOrderQty))) {
    throw new AppError(400, "INVALID_ORDER_GRID", "Order must match the venue symbol, quantity step and price tick");
  }
  if (instrument.mode !== "ORDER_BOOK") throw new AppError(409, "RFQ_REQUIRED", "This instrument requires a negotiated RFQ contract, not an order-book order");
  if (instrument.status !== "ACTIVE") throw new AppError(409, "MARKET_INACTIVE", "Instrument is not active");
  const amount = qty.mul(price).mul(instrument.contractMultiplier);
  if (instrument.minNotional && amount.lt(instrument.minNotional)) throw new AppError(400, "MIN_NOTIONAL", "Order is below the venue minimum notional");
  return {
    symbol: instrument.symbol, side: parsed.side, type: "LIMIT" as const, tif: "IOC" as const,
    qty: qty.toFixed(), price: price.toFixed(), clientUid, clOrdId, quoteCcy: instrument.quoteAsset,
  };
}
