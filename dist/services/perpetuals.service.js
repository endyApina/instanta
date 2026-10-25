"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.perpetualsService = exports.PerpetualsService = void 0;
exports.postPaperJournal = postPaperJournal;
const node_crypto_1 = require("node:crypto");
const client_1 = require("@prisma/client");
const prisma_1 = require("../config/prisma");
const app_error_1 = require("../errors/app-error");
const money_1 = require("../domain/money");
const transaction_service_1 = require("./transaction.service");
const perpetuals_adapter_1 = require("../adapters/perpetuals.adapter");
const bayesshield_adapter_1 = require("../adapters/bayesshield.adapter");
const perpetuals_1 = require("../domain/perpetuals");
const request_hash_1 = require("../domain/request-hash");
const demo_1 = require("../config/demo");
async function paperAccount(tx, userId, asset, code, normalBalance) {
    return tx.globalPaperAccount.upsert({
        where: { userId_asset_code: { userId, asset, code } },
        create: { userId, asset, code, normalBalance }, update: {},
    });
}
async function postPaperJournal(tx, asset, description, entries, reference = (0, node_crypto_1.randomUUID)(), hash = (0, request_hash_1.requestHash)({ asset, description })) {
    const total = entries.reduce((sum, line) => sum.plus(new money_1.MoneyDecimal(line.amount).mul(line.side === "DEBIT" ? 1 : -1)), new money_1.MoneyDecimal(0));
    if (!total.isZero() || entries.length < 2)
        throw new app_error_1.AppError(500, "PAPER_JOURNAL_UNBALANCED", "Paper journal must balance exactly");
    const journal = await tx.globalPaperJournal.create({
        data: { asset, description, reference, requestHash: hash, lines: {
                create: entries.map((line) => ({ accountId: line.account.id, side: line.side, amount: line.amount })),
            } },
    });
    for (const line of entries) {
        const amount = perpetuals_1.positiveGlobalDecimal.parse(line.amount);
        const delta = new money_1.MoneyDecimal(amount).mul(line.side === line.account.normalBalance ? 1 : -1);
        if (new money_1.MoneyDecimal(line.account.balance.toString()).plus(delta).lt(0))
            throw new app_error_1.AppError(409, "PAPER_INSUFFICIENT_BALANCE", "Insufficient paper balance; NGN and other assets cannot fund this order");
        await tx.globalPaperAccount.update({ where: { id: line.account.id }, data: { balance: { increment: delta.toFixed(8) } } });
    }
    return journal;
}
class PerpetualsService {
    venue;
    risk;
    constructor(venue = perpetuals_adapter_1.perpetualsAdapter, risk = new bayesshield_adapter_1.BayesShieldAdapter()) {
        this.venue = venue;
        this.risk = risk;
    }
    async symbols() { return { simulated: this.venue().simulated, instruments: await this.venue().symbols() }; }
    async prepare(input) {
        const instrument = (await this.venue().symbols()).find((item) => item.symbol === input.symbol);
        if (!instrument)
            throw new app_error_1.AppError(404, "GLOBAL_SYMBOL_NOT_FOUND", "Symbol is not in the venue catalog");
        if (!["SPOT", "SECURITY"].includes(instrument.kind) || instrument.mode !== "ORDER_BOOK") {
            throw new app_error_1.AppError(409, "PRODUCT_EXECUTION_DISABLED", "Conventional perpetuals have margin/liquidation risk. Barrier products need certified RFQ terms; both remain view/scenario-only");
        }
        perpetuals_1.globalAsset.parse(instrument.settlementCcy);
        if (!(0, demo_1.isDemoMode)() && instrument.settlementCcy === "NGN")
            throw new app_error_1.AppError(409, "NGN_PAPER_DISABLED", "Naira trading is available only in the isolated demo.");
        if (instrument.settlementCcy !== instrument.quoteAsset)
            throw new app_error_1.AppError(409, "GLOBAL_FX_DISABLED", "Cross-currency settlement is not enabled");
        (0, perpetuals_1.mapSandboxOrder)(instrument, input, "paper-client", "paper-preview");
        const quote = await this.venue().quote(input.symbol);
        const risk = await this.risk.assess({ symbol: input.symbol, side: input.side, qty: input.qty, price: quote.price });
        return { input, instrument, quote, risk };
    }
    async fundPaper(tx, userId, asset, amount, key) {
        if (!(0, demo_1.isDemoMode)() && asset === "NGN")
            throw new app_error_1.AppError(409, "NGN_PAPER_DISABLED", "Naira test funding is available only in the isolated demo.");
        await (0, transaction_service_1.assertWritable)(tx);
        perpetuals_1.positiveGlobalDecimal.parse(amount);
        if (new money_1.MoneyDecimal(amount).gt((0, demo_1.isDemoMode)() ? 5_000_000 : 1_000_000))
            throw new app_error_1.AppError(400, "PAPER_FUNDING_LIMIT", "That test credit is too large.");
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`global-paper:${userId}`}, 7))`;
        const reference = (0, request_hash_1.requestHash)(["global-paper-fund", userId, key]);
        const hash = (0, request_hash_1.requestHash)({ asset, amount });
        const previous = await tx.globalPaperJournal.findUnique({ where: { reference } });
        if (previous) {
            if (previous.requestHash !== hash)
                throw new app_error_1.AppError(409, "IDEMPOTENCY_CONFLICT", "Paper funding key reused for a different credit");
            return { journalId: previous.id, simulated: true };
        }
        const cash = await paperAccount(tx, userId, asset, "CASH", "DEBIT");
        const capital = await paperAccount(tx, userId, asset, "SIMULATED_CAPITAL", "CREDIT");
        const journal = await postPaperJournal(tx, asset, "Explicit simulated funding; no custody or FX", [
            { account: cash, side: "DEBIT", amount }, { account: capital, side: "CREDIT", amount },
        ], reference, hash);
        await tx.auditEvent.create({ data: { actorId: userId, subjectId: userId, action: "GLOBAL_PAPER_FUNDING" } });
        return { journalId: journal.id, simulated: true };
    }
    async findReplay(userId, key, input, db = prisma_1.prisma) {
        const previous = await db.globalPaperOrder.findUnique({ where: { requestKey: (0, request_hash_1.requestHash)(["global-paper-order", userId, key]) } });
        if (previous && previous.requestHash !== (0, request_hash_1.requestHash)(input))
            throw new app_error_1.AppError(409, "IDEMPOTENCY_CONFLICT", "Paper order key reused for a different order");
        return previous;
    }
    async placePaperOrder(tx, userId, input, key, prepared) {
        await (0, transaction_service_1.assertWritable)(tx);
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`global-paper:${userId}`}, 7))`;
        const previous = await this.findReplay(userId, key, input, tx);
        if (previous)
            return { orderId: previous.id, executionMode: "PAPER_ONLY", simulated: true };
        if (!prepared)
            throw new Error("Paper order preparation missing");
        const { instrument, quote, risk } = prepared;
        const account = await tx.wallet.findUnique({ where: { userId } });
        if (!account || account.status !== "ACTIVE")
            throw new app_error_1.AppError(409, "WALLET_INACTIVE", "An active account is required even for paper trading");
        if (Date.now() - quote.at > 10_000 || quote.at > Date.now() + 1000)
            throw new app_error_1.AppError(409, "GLOBAL_PRICE_STALE", "Quote expired. Review a fresh quote before retrying");
        if (Date.now() - Date.parse(risk.assessedAt) > 30_000)
            throw new app_error_1.AppError(409, "GLOBAL_RISK_STALE", "Risk assessment expired. Request a fresh assessment before retrying");
        if (risk.lossProbability === null || risk.lossProbability >= 0.5) {
            if (!input.acknowledgeHighRisk)
                throw new app_error_1.AppError(409, "GLOBAL_RISK_ACK_REQUIRED", risk.warning || "High modeled loss probability; acknowledge the risk to simulate");
        }
        const price = new money_1.MoneyDecimal(quote.price);
        if (input.side === "BUY" ? price.gt(input.limitPrice) : price.lt(input.limitPrice)) {
            throw new app_error_1.AppError(409, "PAPER_LIMIT_NOT_MET", "Current indicative price is outside your limit; no paper fill was created");
        }
        const asset = instrument.settlementCcy;
        const qty = new money_1.MoneyDecimal(input.qty);
        const amount = qty.mul(price).mul(instrument.contractMultiplier);
        if (amount.decimalPlaces() > 8)
            throw new app_error_1.AppError(400, "PAPER_PRECISION", "Fill amount must be exactly representable in eight settlement decimals; increase the quantity step");
        const cash = await paperAccount(tx, userId, asset, "CASH", "DEBIT");
        const holding = await paperAccount(tx, userId, asset, `POSITION:${input.symbol}`, "DEBIT");
        const position = await tx.globalPaperPosition.upsert({
            where: { userId_symbol_asset: { userId, symbol: input.symbol, asset } },
            create: { userId, symbol: input.symbol, asset }, update: {},
        });
        const oldQty = new money_1.MoneyDecimal(position.qty.toString());
        const oldCost = new money_1.MoneyDecimal(position.cost.toString());
        if (input.side === "BUY") {
            await postPaperJournal(tx, asset, "Fully funded paper buy; zero simulated fees", [
                { account: holding, side: "DEBIT", amount: amount.toFixed(8) },
                { account: cash, side: "CREDIT", amount: amount.toFixed(8) },
            ]);
            await tx.globalPaperPosition.update({ where: { id: position.id }, data: { qty: oldQty.plus(qty).toFixed(8), cost: oldCost.plus(amount).toFixed(8) } });
        }
        else {
            if (qty.gt(oldQty))
                throw new app_error_1.AppError(409, "PAPER_INSUFFICIENT_POSITION", "Short selling and borrowed positions are disabled");
            const cost = qty.eq(oldQty) ? oldCost : oldCost.mul(qty).div(oldQty).toDecimalPlaces(8, money_1.MoneyDecimal.ROUND_DOWN);
            if (cost.lte(0))
                throw new app_error_1.AppError(409, "PAPER_PRECISION", "Partial sale cost rounds to zero; sell a larger quantity");
            const difference = amount.minus(cost);
            const entries = [
                { account: cash, side: "DEBIT", amount: amount.toFixed(8) },
                { account: holding, side: "CREDIT", amount: cost.toFixed(8) },
            ];
            if (!difference.isZero()) {
                const pnl = await paperAccount(tx, userId, asset, difference.gt(0) ? "REALIZED_GAIN" : "REALIZED_LOSS", difference.gt(0) ? "CREDIT" : "DEBIT");
                entries.push({ account: pnl, side: difference.gt(0) ? "CREDIT" : "DEBIT", amount: difference.abs().toFixed(8) });
            }
            await postPaperJournal(tx, asset, "Paper sale and realized P&L; no real settlement", entries);
            await tx.globalPaperPosition.update({ where: { id: position.id }, data: { qty: oldQty.minus(qty).toFixed(8), cost: oldCost.minus(cost).toFixed(8) } });
        }
        const order = await tx.globalPaperOrder.create({
            data: {
                userId, requestKey: (0, request_hash_1.requestHash)(["global-paper-order", userId, key]), requestHash: (0, request_hash_1.requestHash)(input),
                symbol: input.symbol, side: input.side, qty: input.qty, price: price.toFixed(8), amount: amount.toFixed(8), asset, risk,
            },
        });
        await tx.auditEvent.create({ data: { actorId: userId, subjectId: order.id, action: "GLOBAL_PAPER_FILL" } });
        return { orderId: order.id, executionMode: "PAPER_ONLY", simulated: true };
    }
    async snapshot(userId) {
        const [accounts, positions, orders] = await prisma_1.prisma.$transaction([
            prisma_1.prisma.globalPaperAccount.findMany({ where: { userId, code: "CASH" } }),
            prisma_1.prisma.globalPaperPosition.findMany({ where: { userId, qty: { gt: 0 } } }),
            prisma_1.prisma.globalPaperOrder.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }),
        ], { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead });
        return {
            executionMode: "PAPER_ONLY",
            balances: ((0, demo_1.isDemoMode)() ? ["NGN", "USD", "USDT", "USDC"] : ["USD", "USDT", "USDC"]).map((asset) => ({
                asset, available: accounts.find((account) => account.asset === asset)?.balance.toFixed(8) ?? "0.00000000",
            })),
            positions: positions.map((position) => ({ symbol: position.symbol, asset: position.asset, qty: position.qty.toFixed(8), cost: position.cost.toFixed(8) })),
            orders: orders.map((order) => ({
                id: order.id, symbol: order.symbol, side: order.side, asset: order.asset,
                qty: order.qty.toFixed(8), price: order.price.toFixed(8), amount: order.amount.toFixed(8), createdAt: order.createdAt.toISOString(),
            })),
        };
    }
}
exports.PerpetualsService = PerpetualsService;
exports.perpetualsService = new PerpetualsService();
