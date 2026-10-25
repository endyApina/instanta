"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wealthRoutes = void 0;
const client_1 = require("@prisma/client");
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const auth_1 = require("../middleware/auth");
const demo_1 = require("../config/demo");
const perpetuals_service_1 = require("../services/perpetuals.service");
const market_data_service_1 = require("../services/market-data.service");
const app_error_1 = require("../errors/app-error");
const session_service_1 = require("../services/session.service");
const money_1 = require("../domain/money");
const wealth_1 = require("../domain/wealth");
exports.wealthRoutes = (0, express_1.Router)();
exports.wealthRoutes.use(auth_1.requireAuth);
exports.wealthRoutes.get("/products", async (request, response, next) => {
    try {
        await (0, session_service_1.enforceRateLimit)(`wealth-products:${request.userId}`, 20, 60, "Please wait a moment before refreshing the asset list.");
        const products = [];
        const unavailable = [];
        const sources = (0, demo_1.isDemoMode)() ? ["DEMO"] : ["PERPETUALS", "NGX", "FMDQ"];
        await Promise.all(sources.map(async (source) => {
            try {
                if (source === "PERPETUALS" || source === "DEMO") {
                    const catalog = await perpetuals_service_1.perpetualsService.symbols();
                    const labels = (0, demo_1.isDemoMode)() ? await prisma_1.prisma.demoInstrument.findMany() : [];
                    for (const instrument of catalog.instruments) {
                        const label = labels.find((row) => row.symbol === instrument.symbol);
                        products.push({ id: `${source}:${instrument.symbol}`, symbol: instrument.symbol,
                            name: label?.name ?? instrument.symbol, category: label?.category ?? instrument.kind,
                            currency: instrument.quoteAsset, source, instrument });
                    }
                }
                else {
                    const catalog = await market_data_service_1.marketData.catalog(source);
                    products.push(...catalog.instruments.map((item) => ({
                        id: `${source}:${item.symbol}`, symbol: item.symbol, name: item.name, category: item.category,
                        currency: item.unit === "NGN" ? "NGN" : item.unit, source,
                    })));
                }
            }
            catch (error) {
                if (!(error instanceof app_error_1.AppError))
                    throw error;
                console.warn(`[WARN] Wealth catalog source unavailable: ${source} ${error.code}`);
                unavailable.push({ source, message: error.message });
            }
        }));
        response.json({ success: true, data: wealth_1.wealthProductsSchema.parse({ products: products.sort((a, b) => a.name.localeCompare(b.name)), unavailable }) });
    }
    catch (error) {
        next(error);
    }
});
exports.wealthRoutes.get("/summary", async (request, response, next) => {
    try {
        const result = await prisma_1.prisma.$transaction(async (tx) => {
            const userId = request.userId;
            const [wallet, goals, accounts, positions, orders, evaluations, activity, cashActivity] = await Promise.all([
                tx.wallet.findUnique({ where: { userId }, include: { ledgerAccount: true } }),
                tx.savingsGoal.findMany({ where: { userId }, include: { ledgerAccount: true }, orderBy: { createdAt: "desc" } }),
                tx.globalPaperAccount.findMany({ where: { userId, code: "CASH" }, orderBy: { asset: "asc" } }),
                tx.globalPaperPosition.findMany({ where: { userId, qty: { gt: 0 } }, orderBy: { symbol: "asc" } }),
                tx.globalPaperOrder.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 }),
                tx.portfolioEvaluation.findMany({ where: { userId }, include: { allocations: true }, orderBy: { createdAt: "desc" }, take: 20 }),
                tx.transaction.findMany({ where: { ledgerAccount: { userId } }, include: { journalEntry: true }, orderBy: { createdAt: "desc" }, take: 100 }),
                tx.globalPaperLine.findMany({ where: { account: { userId, code: "CASH" } }, include: { journal: true },
                    orderBy: [{ journal: { createdAt: "desc" } }, { id: "desc" }], take: 100 }),
            ]);
            const rows = [];
            const localMode = (0, demo_1.isDemoMode)() ? "Demo" : "Account";
            const paperMode = (0, demo_1.isDemoMode)() ? "Demo" : "Practice";
            const history = (accountId) => activity.filter((line) => line.ledgerAccountId === accountId).map((line) => ({
                at: line.createdAt.toISOString(), description: line.journalEntry.description ?? "Account movement", amount: line.amount.toFixed(2),
            }));
            if (wallet && !wallet.ledgerAccount)
                throw new app_error_1.AppError(500, "LEDGER_ACCOUNT_MISSING", "Your cash balance needs attention. Please contact support.");
            if (wallet?.ledgerAccount && (!(0, demo_1.isDemoMode)() || !wallet.ledgerAccount.balance.isZero()))
                rows.push({
                    id: wallet.id, name: "Naira cash wallet", kind: "Cash", currency: "NGN", mode: localMode,
                    amount: wallet.ledgerAccount.balance.toFixed(2), status: wallet.status,
                    detail: "Money available in your account wallet.", yieldEarned: null, protection: "Not an investment; no modeled loss limit.", drift: [], history: history(wallet.ledgerAccount.id),
                });
            for (const account of accounts)
                rows.push({
                    id: account.id, name: `${account.asset} cash`, kind: "Cash", currency: account.asset, mode: paperMode,
                    amount: account.balance.toFixed(8), status: "Available", detail: "Virtual spending balance. This is not a bank deposit or a currency conversion.",
                    yieldEarned: null, protection: "Virtual funds only.", drift: [], history: cashActivity.filter((line) => line.accountId === account.id).map((line) => ({
                        at: line.journal.createdAt.toISOString(), amount: line.amount.toFixed(8),
                        description: `${line.side === "DEBIT" ? "Added to" : "Moved from"} virtual cash: ${line.journal.description.startsWith("Explicit simulated funding") ? "practice funds"
                            : line.journal.description.startsWith("Demo savings transfer") ? "savings contribution"
                                : line.journal.description}`,
                    })),
                });
            for (const goal of goals) {
                if (!goal.ledgerAccount)
                    throw new app_error_1.AppError(500, "LEDGER_ACCOUNT_MISSING", "Your savings balance needs attention. Please contact support.");
                rows.push({
                    id: goal.id, name: goal.name, kind: "Savings goal", currency: "NGN", mode: localMode,
                    amount: goal.ledgerAccount.balance.toFixed(2), status: goal.status, yieldEarned: goal.yieldAccrued.toFixed(2),
                    detail: `Target NGN ${goal.targetAmount.toFixed(2)}. ${goal.lockUntil ? `Locked until ${goal.lockUntil.toISOString()}.` : "No time lock."} Automatic transfers: ${goal.autoSweep ? "requested; scheduling not enabled" : "off"}.`,
                    protection: "A time lock limits access, not investment losses.", drift: [], history: history(goal.ledgerAccount.id),
                });
            }
            for (const position of positions)
                rows.push({
                    id: position.id, name: position.symbol, kind: "Holding", currency: position.asset, mode: paperMode,
                    amount: position.cost.toFixed(8), status: "Held", yieldEarned: null,
                    detail: `${position.qty.toFixed()} units. Amount shown is purchase cost, not today's sale value.`,
                    protection: "No contractual loss limit. You could lose the amount invested.", drift: [],
                    history: orders.filter((order) => order.symbol === position.symbol && order.asset === position.asset).map((order) => ({
                        at: order.createdAt.toISOString(), description: `${order.side === "BUY" ? "Bought" : "Sold"} ${order.qty.toFixed()} units at ${order.price.toFixed()}`, amount: order.amount.toFixed(8),
                    })),
                });
            for (const evaluation of evaluations)
                rows.push({
                    id: evaluation.id, name: "Portfolio plan", kind: "Plan (not invested)", currency: "NGN", mode: "Model",
                    amount: evaluation.principal.toFixed(2), status: evaluation.shouldRebalance ? "Adjustment suggested" : "On target", yieldEarned: null,
                    detail: `Saved ${evaluation.createdAt.toISOString()}. This is a calculation, not a funded portfolio. Differences below are from that snapshot, not live daily monitoring.`,
                    protection: `Modeled minimum value: NGN ${evaluation.floorValue.toFixed(2)}. This is an estimate, not a guarantee.`,
                    drift: evaluation.allocations.map((allocation) => ({ asset: allocation.assetClass, percentagePoints: allocation.driftPercentagePoints.toFixed() })), history: [],
                });
            const totals = new Map();
            for (const row of rows.filter((row) => row.mode !== "Model")) {
                const key = `${row.currency}:${row.mode}`;
                const previous = totals.get(key);
                totals.set(key, { currency: row.currency, mode: row.mode, amount: new money_1.MoneyDecimal(previous?.amount ?? "0").plus(row.amount).toFixed() });
            }
            return { demo: (0, demo_1.isDemoMode)(), rows, totals: [...totals.values()] };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead });
        response.json({ success: true, data: result });
    }
    catch (error) {
        next(error);
    }
});
