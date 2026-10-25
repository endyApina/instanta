"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireDemoMode = requireDemoMode;
exports.assertDemoDatabase = assertDemoDatabase;
exports.demoInstruments = demoInstruments;
exports.demoQuote = demoQuote;
exports.seedDemoFunds = seedDemoFunds;
exports.openDemoSession = openDemoSession;
exports.demoSavingsTransfer = demoSavingsTransfer;
exports.rebalanceDemo = rebalanceDemo;
const node_crypto_1 = require("node:crypto");
const prisma_1 = require("../config/prisma");
const demo_1 = require("../config/demo");
const app_error_1 = require("../errors/app-error");
const transaction_service_1 = require("./transaction.service");
const pii_service_1 = require("./pii.service");
const auth_service_1 = require("./auth.service");
const session_service_1 = require("./session.service");
const ledger_service_1 = require("./ledger.service");
const perpetuals_service_1 = require("./perpetuals.service");
const money_1 = require("../domain/money");
const listings = [
    { symbol: "DEMO-TBILL", name: "Nigerian Treasury bill (demo)", category: "TREASURY_BILL", asset: "NGN", price: "100", tickSize: "0.01", qtyStep: "0.01" },
    { symbol: "DEMO-MMF", name: "Nigerian money market fund (demo)", category: "MMF", asset: "NGN", price: "1", tickSize: "0.01", qtyStep: "0.01" },
    { symbol: "DEMO-NGX", name: "Nigerian share (demo)", category: "EQUITY", asset: "NGN", price: "50", tickSize: "0.01", qtyStep: "1" },
    { symbol: "DEMO-ETF", name: "Nigerian share fund (demo)", category: "ETF", asset: "NGN", price: "100", tickSize: "0.01", qtyStep: "1" },
    { symbol: "DEMO-BTCUSD", name: "Bitcoin (demo)", category: "CRYPTO", asset: "USD", price: "60000", tickSize: "0.01", qtyStep: "0.00001" },
    { symbol: "DEMO-STOCKUSD", name: "Tokenized company share (demo)", category: "TOKENIZED_STOCK", asset: "USD", price: "200", tickSize: "0.01", qtyStep: "0.01" },
    { symbol: "DEMO-INDEXUSD", name: "Global index (demo)", category: "INDEX", asset: "USD", price: "5000", tickSize: "0.01", qtyStep: "0.001" },
];
function requireDemoMode() {
    (0, demo_1.assertDemoConfiguration)();
    if (!(0, demo_1.isDemoMode)())
        throw new app_error_1.AppError(403, "DEMO_DISABLED", "This server is not a demo. Start a separate demo database to try simulated features.");
}
async function assertDemoDatabase() {
    requireDemoMode();
    if (await prisma_1.prisma.user.count({ where: { isDemo: false } }))
        throw new Error("Demo mode cannot use a database containing real-mode accounts");
}
async function demoInstruments() {
    requireDemoMode();
    await prisma_1.prisma.demoInstrument.createMany({ data: listings, skipDuplicates: true });
    const rows = await prisma_1.prisma.demoInstrument.findMany({ orderBy: { symbol: "asc" } });
    return rows.map((row) => ({
        symbol: row.symbol, kind: "SPOT", mode: "ORDER_BOOK", baseAsset: row.symbol, quoteAsset: row.asset,
        settlementCcy: row.asset, tickSize: row.tickSize.toFixed(), qtyStep: row.qtyStep.toFixed(),
        minQty: row.qtyStep.toFixed(), contractMultiplier: "1", status: "ACTIVE",
    }));
}
async function demoQuote(symbol) {
    requireDemoMode();
    const row = await prisma_1.prisma.demoInstrument.findUnique({ where: { symbol } });
    if (!row)
        throw new app_error_1.AppError(404, "DEMO_ASSET_NOT_FOUND", "Choose an asset from the demo list.");
    return { symbol, price: row.price.toFixed(), at: Date.now(), simulated: true };
}
async function seedDemoFunds(tx, userId) {
    requireDemoMode();
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.isDemo)
        throw new app_error_1.AppError(403, "DEMO_ACCOUNT_REQUIRED", "Virtual funds can only be added to a demo account.");
    await perpetuals_service_1.perpetualsService.fundPaper(tx, userId, "NGN", "5000000", "initial-demo-ngn");
    await perpetuals_service_1.perpetualsService.fundPaper(tx, userId, "USD", "10000", "initial-demo-usd");
}
async function openDemoSession(identity, fingerprint) {
    await assertDemoDatabase();
    await demoInstruments();
    return (0, transaction_service_1.serializable)(async (tx) => {
        const key = (0, session_service_1.secureHash)(`demo-identity:${identity}`);
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${key}, 9))`;
        const existing = await tx.demoIdentity.findUnique({ where: { key } });
        let userId = existing?.userId;
        if (!userId) {
            const email = `${(0, node_crypto_1.randomUUID)()}@demo.invalid`;
            const user = await tx.user.create({ data: {
                    email: (0, pii_service_1.encryptPii)(email), emailLookupHash: (0, pii_service_1.piiLookupHash)(`email:${email}`), firstName: (0, pii_service_1.encryptPii)("Demo"),
                    lastName: (0, pii_service_1.encryptPii)("Explorer"), passwordHash: await (0, auth_service_1.hashPassword)((0, node_crypto_1.randomBytes)(32).toString("hex")),
                    isDemo: true, kycStatus: "VERIFIED", maxTolerableLoss: "0", targetReturn: "0",
                } });
            userId = user.id;
            const wallet = await tx.wallet.create({ data: { userId } });
            await (0, ledger_service_1.provisionLedgerAccounts)(tx, userId, wallet.id);
            await tx.demoIdentity.create({ data: { key, userId } });
            await seedDemoFunds(tx, userId);
        }
        const session = await tx.authSession.create({ data: { userId, deviceHash: fingerprint, expiresAt: new Date(Date.now() + 3600_000) } });
        return { accessToken: (0, auth_service_1.issueAccessToken)(userId, session.id, fingerprint), demo: true };
    });
}
async function demoSavingsTransfer(tx, userId, amount) {
    requireDemoMode();
    if (new money_1.MoneyDecimal(amount).isZero())
        return;
    await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`global-paper:${userId}`}, 7))`;
    const cash = await tx.globalPaperAccount.findUniqueOrThrow({ where: { userId_asset_code: { userId, asset: "NGN", code: "CASH" } } });
    const out = await tx.globalPaperAccount.upsert({
        where: { userId_asset_code: { userId, asset: "NGN", code: "DEMO_TRANSFER_OUT" } },
        create: { userId, asset: "NGN", code: "DEMO_TRANSFER_OUT", normalBalance: "DEBIT" }, update: {},
    });
    await (0, perpetuals_service_1.postPaperJournal)(tx, "NGN", "Demo savings transfer; no bank payment", [
        { account: cash, side: "CREDIT", amount }, { account: out, side: "DEBIT", amount },
    ]);
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId }, include: { ledgerAccount: true } });
    if (!wallet.ledgerAccount)
        throw new Error("Demo wallet ledger missing");
    await (0, ledger_service_1.createDepositJournal)(tx, wallet.ledgerAccount.id, amount, `demo-savings:${(0, node_crypto_1.randomUUID)()}`, "Database-only demo transfer");
}
async function rebalanceDemo(tx, userId) {
    requireDemoMode();
    const positions = await tx.globalPaperPosition.findMany({ where: { userId, qty: { gt: 0 } }, orderBy: { symbol: "asc" } });
    if (positions.length > 50)
        throw new app_error_1.AppError(409, "DEMO_REBALANCE_LIMIT", "Rebalance up to 50 holdings at a time.");
    const orders = [];
    // Rebalance per currency, never by inventing an FX rate. Each asset gets an equal share.
    for (const asset of [...new Set(positions.map((position) => position.asset))].sort()) {
        const group = positions.filter((position) => position.asset === asset);
        if (group.length < 2)
            continue;
        const quotes = await Promise.all(group.map(async (position) => ({ position, quote: await demoQuote(position.symbol) })));
        const target = quotes.reduce((sum, item) => sum.plus(new money_1.MoneyDecimal(item.position.qty.toString()).mul(item.quote.price)), new money_1.MoneyDecimal(0)).div(group.length);
        const trades = quotes.map(({ position, quote }) => {
            const listing = listings.find((item) => item.symbol === position.symbol);
            if (!listing)
                throw new Error("Demo listing missing");
            const diff = target.div(quote.price).minus(position.qty.toString());
            return { symbol: position.symbol, side: diff.lt(0) ? "SELL" : "BUY",
                qty: diff.abs().div(listing.qtyStep).floor().mul(listing.qtyStep).toFixed(),
                limitPrice: quote.price, acknowledgeHighRisk: true };
        }).filter((trade) => new money_1.MoneyDecimal(trade.qty).gt(0)).sort((a, b) => (a.side === "SELL" ? -1 : 1) - (b.side === "SELL" ? -1 : 1));
        for (const input of trades) {
            const prepared = await perpetuals_service_1.perpetualsService.prepare(input);
            const order = await perpetuals_service_1.perpetualsService.placePaperOrder(tx, userId, input, (0, node_crypto_1.randomUUID)(), prepared);
            orders.push(order.orderId);
        }
    }
    await tx.auditEvent.create({ data: { actorId: userId, subjectId: userId, action: "DEMO_REBALANCE" } });
    return { trades: orders.length, message: orders.length ? "Demo holdings were adjusted to equal shares within each currency." : "No adjustment was needed. Hold at least two assets in the same currency to try this." };
}
