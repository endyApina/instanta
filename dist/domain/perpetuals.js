"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalSnapshotSchema = exports.globalEventSchema = exports.riskScoreSchema = exports.paperOrderSchema = exports.globalInstrumentsSchema = exports.instrumentSchema = exports.globalAsset = exports.globalSymbol = exports.positiveGlobalDecimal = exports.globalDecimal = void 0;
exports.sizeLossBoundedPosition = sizeLossBoundedPosition;
exports.mapSandboxOrder = mapSandboxOrder;
const zod_1 = require("zod");
const money_1 = require("./money");
const app_error_1 = require("../errors/app-error");
exports.globalDecimal = zod_1.z.string().regex(/^\d{1,18}(\.\d{1,8})?$/);
exports.positiveGlobalDecimal = exports.globalDecimal.refine((value) => new money_1.MoneyDecimal(value).gt(0), "Value must be positive");
exports.globalSymbol = zod_1.z.string().min(2).max(64).regex(/^[A-Za-z0-9_.-]+$/);
exports.globalAsset = zod_1.z.enum(["NGN", "USD", "USDT", "USDC"]);
exports.instrumentSchema = zod_1.z.object({
    symbol: exports.globalSymbol, kind: zod_1.z.string(), mode: zod_1.z.string(), baseAsset: zod_1.z.string().min(1),
    quoteAsset: zod_1.z.string().min(1), settlementCcy: zod_1.z.string().min(1),
    tickSize: exports.positiveGlobalDecimal, qtyStep: exports.positiveGlobalDecimal, minQty: exports.positiveGlobalDecimal,
    contractMultiplier: exports.positiveGlobalDecimal, status: zod_1.z.string(),
    minNotional: exports.globalDecimal.optional(), maxOrderQty: exports.positiveGlobalDecimal.optional(),
});
exports.globalInstrumentsSchema = zod_1.z.object({
    simulated: zod_1.z.boolean(), instruments: zod_1.z.array(exports.instrumentSchema).max(5000),
});
exports.paperOrderSchema = zod_1.z.object({
    symbol: exports.globalSymbol, side: zod_1.z.enum(["BUY", "SELL"]), qty: exports.positiveGlobalDecimal,
    limitPrice: exports.positiveGlobalDecimal, acknowledgeHighRisk: zod_1.z.boolean().default(false),
});
exports.riskScoreSchema = zod_1.z.object({
    source: zod_1.z.enum(["BAYESSHIELD_GATEWAY", "UNAVAILABLE"]), simulated: zod_1.z.boolean(),
    lossProbability: zod_1.z.number().finite().min(0).max(1).nullable(),
    winProbability: zod_1.z.number().finite().min(0).max(1).nullable(),
    warning: zod_1.z.string(), assessedAt: zod_1.z.string().datetime(),
});
exports.globalEventSchema = zod_1.z.object({
    region: zod_1.z.enum(["LOCAL", "GLOBAL"]), provider: zod_1.z.string(), simulated: zod_1.z.boolean(),
    symbol: zod_1.z.string(), channel: zod_1.z.string(), receivedAt: zod_1.z.string().datetime(), data: zod_1.z.unknown(),
});
exports.globalSnapshotSchema = zod_1.z.object({
    executionMode: zod_1.z.literal("PAPER_ONLY"),
    balances: zod_1.z.array(zod_1.z.object({ asset: exports.globalAsset, available: exports.globalDecimal })),
    positions: zod_1.z.array(zod_1.z.object({ symbol: zod_1.z.string(), asset: exports.globalAsset, qty: exports.globalDecimal, cost: exports.globalDecimal })),
    orders: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(), symbol: zod_1.z.string(), side: zod_1.z.enum(["BUY", "SELL"]), qty: exports.globalDecimal,
        price: exports.globalDecimal, amount: exports.globalDecimal, asset: exports.globalAsset, createdAt: zod_1.z.string(),
    })),
});
/** Conventional perpetuals do not acquire a loss cap from a stop-loss or a model probability. */
function sizeLossBoundedPosition(input) {
    const principal = new money_1.MoneyDecimal(exports.positiveGlobalDecimal.parse(input.principal));
    const fraction = new money_1.MoneyDecimal(exports.globalDecimal.parse(input.maxLossFraction));
    const premium = new money_1.MoneyDecimal(exports.positiveGlobalDecimal.parse(input.unitPremium));
    const fees = new money_1.MoneyDecimal(exports.globalDecimal.parse(input.fees));
    const step = new money_1.MoneyDecimal(exports.positiveGlobalDecimal.parse(input.qtyStep));
    if (fraction.gt(1))
        throw new app_error_1.AppError(400, "INVALID_RISK_BUDGET", "Loss fraction must be between zero and one");
    const budget = principal.mul(fraction).toDecimalPlaces(8, money_1.MoneyDecimal.ROUND_DOWN);
    if (fees.gte(budget))
        return { qty: "0", maximumLoss: "0", budget: budget.toFixed(8) };
    const qty = budget.minus(fees).div(premium).div(step).floor().mul(step);
    if (qty.isZero())
        return { qty: "0", maximumLoss: "0", budget: budget.toFixed(8) };
    return { qty: qty.toFixed(8), maximumLoss: qty.mul(premium).plus(fees).toFixed(8, money_1.MoneyDecimal.ROUND_UP), budget: budget.toFixed(8) };
}
function mapSandboxOrder(instrument, input, clientUid, clOrdId) {
    const parsed = exports.paperOrderSchema.parse(input);
    const qty = new money_1.MoneyDecimal(parsed.qty);
    const price = new money_1.MoneyDecimal(parsed.limitPrice);
    if (parsed.symbol !== instrument.symbol || !qty.mod(instrument.qtyStep).isZero()
        || !price.mod(instrument.tickSize).isZero() || qty.lt(instrument.minQty)
        || (instrument.maxOrderQty && qty.gt(instrument.maxOrderQty))) {
        throw new app_error_1.AppError(400, "INVALID_ORDER_GRID", "Order must match the venue symbol, quantity step and price tick");
    }
    if (instrument.mode !== "ORDER_BOOK")
        throw new app_error_1.AppError(409, "RFQ_REQUIRED", "This instrument requires a negotiated RFQ contract, not an order-book order");
    if (instrument.status !== "ACTIVE")
        throw new app_error_1.AppError(409, "MARKET_INACTIVE", "Instrument is not active");
    const amount = qty.mul(price).mul(instrument.contractMultiplier);
    if (instrument.minNotional && amount.lt(instrument.minNotional))
        throw new app_error_1.AppError(400, "MIN_NOTIONAL", "Order is below the venue minimum notional");
    return {
        symbol: instrument.symbol, side: parsed.side, type: "LIMIT", tif: "IOC",
        qty: qty.toFixed(), price: price.toFixed(), clientUid, clOrdId, quoteCcy: instrument.quoteAsset,
    };
}
