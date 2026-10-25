import { randomUUID, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { assertDemoConfiguration, isDemoMode } from "../config/demo";
import { AppError } from "../errors/app-error";
import { serializable } from "./transaction.service";
import { encryptPii, piiLookupHash } from "./pii.service";
import { hashPassword, issueAccessToken } from "./auth.service";
import { secureHash } from "./session.service";
import { provisionLedgerAccounts, createDepositJournal } from "./ledger.service";
import { perpetualsService, postPaperJournal } from "./perpetuals.service";
import { MoneyDecimal as D } from "../domain/money";
import type { GlobalInstrument } from "../domain/perpetuals";

const listings = [
  { symbol: "DEMO-TBILL", name: "Nigerian Treasury bill (demo)", category: "TREASURY_BILL", asset: "NGN", price: "100", tickSize: "0.01", qtyStep: "0.01" },
  { symbol: "DEMO-MMF", name: "Nigerian money market fund (demo)", category: "MMF", asset: "NGN", price: "1", tickSize: "0.01", qtyStep: "0.01" },
  { symbol: "DEMO-NGX", name: "Nigerian share (demo)", category: "EQUITY", asset: "NGN", price: "50", tickSize: "0.01", qtyStep: "1" },
  { symbol: "DEMO-ETF", name: "Nigerian share fund (demo)", category: "ETF", asset: "NGN", price: "100", tickSize: "0.01", qtyStep: "1" },
  { symbol: "DEMO-BTCUSD", name: "Bitcoin (demo)", category: "CRYPTO", asset: "USD", price: "60000", tickSize: "0.01", qtyStep: "0.00001" },
  { symbol: "DEMO-STOCKUSD", name: "Tokenized company share (demo)", category: "TOKENIZED_STOCK", asset: "USD", price: "200", tickSize: "0.01", qtyStep: "0.01" },
  { symbol: "DEMO-INDEXUSD", name: "Global index (demo)", category: "INDEX", asset: "USD", price: "5000", tickSize: "0.01", qtyStep: "0.001" },
];
export function requireDemoMode() {
  assertDemoConfiguration();
  if (!isDemoMode()) throw new AppError(403, "DEMO_DISABLED", "This server is not a demo. Start a separate demo database to try simulated features.");
}
export async function assertDemoDatabase() {
  requireDemoMode();
  if (await prisma.user.count({ where: { isDemo: false } })) throw new Error("Demo mode cannot use a database containing real-mode accounts");
}
export async function demoInstruments(): Promise<GlobalInstrument[]> {
  requireDemoMode();
  await prisma.demoInstrument.createMany({ data: listings, skipDuplicates: true });
  const rows = await prisma.demoInstrument.findMany({ orderBy: { symbol: "asc" } });
  return rows.map((row) => ({
    symbol: row.symbol, kind: "SPOT", mode: "ORDER_BOOK", baseAsset: row.symbol, quoteAsset: row.asset,
    settlementCcy: row.asset, tickSize: row.tickSize.toFixed(), qtyStep: row.qtyStep.toFixed(),
    minQty: row.qtyStep.toFixed(), contractMultiplier: "1", status: "ACTIVE",
  }));
}
export async function demoQuote(symbol: string) {
  requireDemoMode();
  const row = await prisma.demoInstrument.findUnique({ where: { symbol } });
  if (!row) throw new AppError(404, "DEMO_ASSET_NOT_FOUND", "Choose an asset from the demo list.");
  return { symbol, price: row.price.toFixed(), at: Date.now(), simulated: true };
}
export async function seedDemoFunds(tx: Prisma.TransactionClient, userId: string) {
  requireDemoMode();
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.isDemo) throw new AppError(403, "DEMO_ACCOUNT_REQUIRED", "Virtual funds can only be added to a demo account.");
  await perpetualsService.fundPaper(tx, userId, "NGN", "5000000", "initial-demo-ngn");
  await perpetualsService.fundPaper(tx, userId, "USD", "10000", "initial-demo-usd");
}
export async function openDemoSession(identity: string, fingerprint: string) {
  await assertDemoDatabase();
  await demoInstruments();
  return serializable(async (tx) => {
    const key = secureHash(`demo-identity:${identity}`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 9))`;
    const existing = await tx.demoIdentity.findUnique({ where: { key } });
    let userId = existing?.userId;
    if (!userId) {
      const email = `${randomUUID()}@demo.invalid`;
      const user = await tx.user.create({ data: {
        email: encryptPii(email), emailLookupHash: piiLookupHash(`email:${email}`), firstName: encryptPii("Demo"),
        lastName: encryptPii("Explorer"), passwordHash: await hashPassword(randomBytes(32).toString("hex")),
        isDemo: true, kycStatus: "VERIFIED", maxTolerableLoss: "0", targetReturn: "0",
      } });
      userId = user.id;
      const wallet = await tx.wallet.create({ data: { userId } });
      await provisionLedgerAccounts(tx, userId, wallet.id);
      await tx.demoIdentity.create({ data: { key, userId } });
      await seedDemoFunds(tx, userId);
    }
    const session = await tx.authSession.create({ data: { userId, deviceHash: fingerprint, expiresAt: new Date(Date.now() + 3600_000) } });
    return { accessToken: issueAccessToken(userId, session.id, fingerprint), demo: true };
  });
}

export async function demoSavingsTransfer(tx: Prisma.TransactionClient, userId: string, amount: string) {
  requireDemoMode();
  if (new D(amount).isZero()) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`global-paper:${userId}`}, 7))`;
  const cash = await tx.globalPaperAccount.findUniqueOrThrow({ where: { userId_asset_code: { userId, asset: "NGN", code: "CASH" } } });
  const out = await tx.globalPaperAccount.upsert({
    where: { userId_asset_code: { userId, asset: "NGN", code: "DEMO_TRANSFER_OUT" } },
    create: { userId, asset: "NGN", code: "DEMO_TRANSFER_OUT", normalBalance: "DEBIT" }, update: {},
  });
  await postPaperJournal(tx, "NGN", "Demo savings transfer; no bank payment", [
    { account: cash, side: "CREDIT", amount }, { account: out, side: "DEBIT", amount },
  ]);
  const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId }, include: { ledgerAccount: true } });
  if (!wallet.ledgerAccount) throw new Error("Demo wallet ledger missing");
  await createDepositJournal(tx, wallet.ledgerAccount.id, amount, `demo-savings:${randomUUID()}`, "Database-only demo transfer");
}

export async function rebalanceDemo(tx: Prisma.TransactionClient, userId: string) {
  requireDemoMode();
  const positions = await tx.globalPaperPosition.findMany({ where: { userId, qty: { gt: 0 } }, orderBy: { symbol: "asc" } });
  if (positions.length > 50) throw new AppError(409, "DEMO_REBALANCE_LIMIT", "Rebalance up to 50 holdings at a time.");
  const orders: string[] = [];
  // Rebalance per currency, never by inventing an FX rate. Each asset gets an equal share.
  for (const asset of [...new Set(positions.map((position) => position.asset))].sort()) {
    const group = positions.filter((position) => position.asset === asset);
    if (group.length < 2) continue;
    const quotes = await Promise.all(group.map(async (position) => ({ position, quote: await demoQuote(position.symbol) })));
    const target = quotes.reduce((sum, item) => sum.plus(new D(item.position.qty.toString()).mul(item.quote.price)), new D(0)).div(group.length);
    const trades = quotes.map(({ position, quote }) => {
      const listing = listings.find((item) => item.symbol === position.symbol);
      if (!listing) throw new Error("Demo listing missing");
      const diff = target.div(quote.price).minus(position.qty.toString());
      return { symbol: position.symbol, side: diff.lt(0) ? "SELL" as const : "BUY" as const,
        qty: diff.abs().div(listing.qtyStep).floor().mul(listing.qtyStep).toFixed(),
        limitPrice: quote.price, acknowledgeHighRisk: true };
    }).filter((trade) => new D(trade.qty).gt(0)).sort((a, b) => (a.side === "SELL" ? -1 : 1) - (b.side === "SELL" ? -1 : 1));
    for (const input of trades) {
      const prepared = await perpetualsService.prepare(input);
      const order = await perpetualsService.placePaperOrder(tx, userId, input, randomUUID(), prepared);
      orders.push(order.orderId);
    }
  }
  await tx.auditEvent.create({ data: { actorId: userId, subjectId: userId, action: "DEMO_REBALANCE" } });
  return { trades: orders.length, message: orders.length ? "Demo holdings were adjusted to equal shares within each currency." : "No adjustment was needed. Hold at least two assets in the same currency to try this." };
}
