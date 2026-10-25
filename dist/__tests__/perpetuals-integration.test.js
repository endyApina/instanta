"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const node_events_1 = require("node:events");
const node_crypto_1 = require("node:crypto");
const ws_1 = require("ws");
const perpetuals_adapter_1 = require("../adapters/perpetuals.adapter");
const perpetuals_1 = require("../domain/perpetuals");
const bayesshield_adapter_1 = require("../adapters/bayesshield.adapter");
const money_1 = require("../domain/money");
const liveConfig = { environment: "test", venue: "sandbox", key: "test-key", secret: "test-secret" };
const instrument = perpetuals_1.instrumentSchema.parse({
    symbol: "BTC-USD-PERP", kind: "PERP", mode: "ORDER_BOOK", baseAsset: "BTC",
    quoteAsset: "USD", settlementCcy: "USD", tickSize: "0.5", qtyStep: "0.001",
    minQty: "0.001", contractMultiplier: "1", status: "ACTIVE",
});
const envelope = (data) => Response.json({ code: 0, data, msg: "ok", ts: Date.now(), asOfSeq: 1 });
(0, node_test_1.default)("REST HMAC matches the official Kronos X vector and signs exact query/body bytes", () => {
    strict_1.default.equal((0, perpetuals_adapter_1.signPerpetualsRequest)("test-secret", "1700000000000", "GET", "/v1/account"), "741b61b6d3740ede7864551612095d2fb73b75a4f70534f45e9e207bdd1f321c");
    strict_1.default.notEqual((0, perpetuals_adapter_1.signPerpetualsRequest)("s", "1", "GET", "/v1/test?a=1&b=2"), (0, perpetuals_adapter_1.signPerpetualsRequest)("s", "1", "GET", "/v1/test?b=2&a=1"));
    strict_1.default.notEqual((0, perpetuals_adapter_1.signPerpetualsRequest)("s", "1", "POST", "/v1/test", '{"a":1}'), (0, perpetuals_adapter_1.signPerpetualsRequest)("s", "1", "POST", "/v1/test", '{ "a": 1 }'));
});
(0, node_test_1.default)("missing credentials warn loudly and stream explicitly simulated prices; production fails closed", async (context) => {
    const warnings = [];
    context.mock.method(console, "warn", (...args) => { warnings.push(args); });
    const adapter = new perpetuals_adapter_1.PerpetualsAdapter({ environment: "staging", venue: "sandbox" });
    strict_1.default.equal(adapter.simulated, true);
    strict_1.default.match(String(warnings[0]?.[0]), /PERPETUALS.COM API KEY MISSING: Falling back to simulated global market feed/);
    strict_1.default.throws(() => new perpetuals_adapter_1.PerpetualsAdapter({ environment: "production", venue: "production" }), /credentials are required/);
    const events = [];
    const stop = adapter.subscribe("BTCUSDT", (event) => { events.push(event); }, (error) => { throw error; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    strict_1.default.ok(events.some((event) => event.channel === "quotes"));
    strict_1.default.ok(events.some((event) => event.channel === "marks"));
    strict_1.default.ok(events.some((event) => event.channel === "orderbook"));
    strict_1.default.ok(events.every((event) => event.simulated));
    await strict_1.default.rejects(adapter.quote("UNLISTEDUSDT"), /venue catalog/);
});
(0, node_test_1.default)("order mapping respects metadata, precision and exact venue symbols", () => {
    const mapped = (0, perpetuals_1.mapSandboxOrder)(instrument, { symbol: instrument.symbol, side: "BUY", qty: "0.003", limitPrice: "60000.5" }, "instanta-user", "stable-ref");
    strict_1.default.equal(mapped.qty, "0.003");
    strict_1.default.equal(mapped.price, "60000.5");
    strict_1.default.equal(mapped.clientUid, "instanta-user");
    strict_1.default.equal(mapped.clOrdId, "stable-ref");
    strict_1.default.throws(() => (0, perpetuals_1.mapSandboxOrder)(instrument, { symbol: "BTCUSDT", side: "BUY", qty: "0.003", limitPrice: "60000.5" }, "u", "r"), /venue symbol/);
    strict_1.default.throws(() => (0, perpetuals_1.mapSandboxOrder)(instrument, { symbol: instrument.symbol, side: "BUY", qty: "0.0001", limitPrice: "60000.5" }, "u", "r"), /quantity step/);
    strict_1.default.throws(() => (0, perpetuals_1.mapSandboxOrder)({ ...instrument, mode: "RFQ", kind: "BARRIER" }, { symbol: instrument.symbol, side: "BUY", qty: "1", limitPrice: "1" }, "u", "r"), /RFQ/);
});
(0, node_test_1.default)("volatile premiums reduce position size without breaching a decimal ATP loss budget", () => {
    let previous = new money_1.MoneyDecimal("1000000");
    for (const premium of ["0.00000001", "0.11", "3.33333333", "50", "99999"]) {
        const sized = (0, perpetuals_1.sizeLossBoundedPosition)({ principal: "1000", maxLossFraction: "0.1", unitPremium: premium, fees: "1.00000001", qtyStep: "0.00000001" });
        const qty = new money_1.MoneyDecimal(sized.qty);
        strict_1.default.ok(qty.mul(premium).plus(qty.isZero() ? 0 : "1.00000001").lte(100));
        strict_1.default.ok(new money_1.MoneyDecimal(sized.maximumLoss).lte(100));
        if (premium !== "0.00000001")
            strict_1.default.ok(qty.lte(previous));
        previous = qty;
    }
    strict_1.default.equal((0, perpetuals_1.sizeLossBoundedPosition)({ principal: "1", maxLossFraction: "0", unitPremium: "1", fees: "0", qtyStep: "1" }).qty, "0");
    strict_1.default.throws(() => (0, perpetuals_1.sizeLossBoundedPosition)({ principal: "1", maxLossFraction: "2", unitPremium: "1", fees: "0", qtyStep: "1" }), /between zero and one/);
    strict_1.default.throws(() => (0, perpetuals_1.sizeLossBoundedPosition)({ principal: "1", maxLossFraction: "0.1", unitPremium: "NaN", fees: "0", qtyStep: "1" }));
});
(0, node_test_1.default)("signed sandbox orders check engine rejection and never retry ambiguous outcomes", async (context) => {
    const mapped = (0, perpetuals_1.mapSandboxOrder)(instrument, { symbol: instrument.symbol, side: "BUY", qty: "0.001", limitPrice: "60000" }, "end-client", "stable-ref");
    let calls = 0;
    let timeout = false;
    context.mock.method(globalThis, "fetch", async (input, init) => {
        calls++;
        if (timeout)
            throw new Error("timeout after upstream accepted");
        strict_1.default.equal(String(input), "https://sandbox.mtf.perpetuals.net/v1/orders");
        const headers = new Headers(init?.headers);
        strict_1.default.equal(headers.get("X-API-Key"), "test-key");
        strict_1.default.equal(headers.get("X-Signature"), (0, perpetuals_adapter_1.signPerpetualsRequest)("test-secret", headers.get("X-Timestamp"), "POST", "/v1/orders", String(init?.body)));
        return envelope({ ...mapped, status: "REJECTED", rejectCode: 2005 });
    });
    await strict_1.default.rejects(new perpetuals_adapter_1.PerpetualsAdapter(liveConfig).submitSandboxOrder(mapped), /engine rejected/);
    strict_1.default.equal(calls, 1);
    timeout = true;
    await strict_1.default.rejects(new perpetuals_adapter_1.PerpetualsAdapter(liveConfig).submitSandboxOrder(mapped), /outcome is uncertain/);
    strict_1.default.equal(calls, 2);
    await strict_1.default.rejects(new perpetuals_adapter_1.PerpetualsAdapter({ ...liveConfig, venue: "production" }).submitSandboxOrder(mapped), /Only credentialed sandbox/);
});
(0, node_test_1.default)("venue rate-limit hints prevent immediate retries and live failures never switch to mock", async (context) => {
    let calls = 0;
    context.mock.method(globalThis, "fetch", async () => {
        calls++;
        return Response.json({ code: 1003, msg: "limited", data: { retryAfterMs: 10_000 }, ts: Date.now() }, { status: 429 });
    });
    const adapter = new perpetuals_adapter_1.PerpetualsAdapter(liveConfig);
    await strict_1.default.rejects(adapter.symbols(), /rate limit/);
    await strict_1.default.rejects(adapter.symbols(), /cooldown/);
    strict_1.default.equal(calls, 1);
    strict_1.default.equal(adapter.simulated, false);
});
(0, node_test_1.default)("BayesShield missing configuration returns unknown risk, never a fabricated probability", async () => {
    const previous = process.env.BAYESSHIELD_GATEWAY_URL;
    delete process.env.BAYESSHIELD_GATEWAY_URL;
    try {
        const risk = await new bayesshield_adapter_1.BayesShieldAdapter().assess({ symbol: "BTCUSDT", side: "BUY", qty: "1", price: "1" });
        strict_1.default.equal(risk.lossProbability, null);
        strict_1.default.equal(risk.winProbability, null);
        strict_1.default.equal(risk.source, "UNAVAILABLE");
    }
    finally {
        if (previous !== undefined)
            process.env.BAYESSHIELD_GATEWAY_URL = previous;
    }
});
(0, node_test_1.default)("BayesShield gateway rejects uncorrelated probabilities and blocks failed risk calls", async (context) => {
    const previousUrl = process.env.BAYESSHIELD_GATEWAY_URL;
    const previousKey = process.env.BAYESSHIELD_API_KEY;
    process.env.BAYESSHIELD_GATEWAY_URL = "https://risk.example.invalid";
    process.env.BAYESSHIELD_API_KEY = "test-key";
    context.after(() => {
        if (previousUrl === undefined)
            delete process.env.BAYESSHIELD_GATEWAY_URL;
        else
            process.env.BAYESSHIELD_GATEWAY_URL = previousUrl;
        if (previousKey === undefined)
            delete process.env.BAYESSHIELD_API_KEY;
        else
            process.env.BAYESSHIELD_API_KEY = previousKey;
    });
    let wrongSymbol = false;
    context.mock.method(globalThis, "fetch", async (_input, init) => {
        const input = JSON.parse(String(init?.body));
        return Response.json({
            ...input, symbol: wrongSymbol ? "OTHER" : input.symbol, source: "BAYESSHIELD_GATEWAY", simulated: false,
            winProbability: 0.3, lossProbability: 0.7, warning: "High loss probability", assessedAt: new Date().toISOString(),
        });
    });
    const adapter = new bayesshield_adapter_1.BayesShieldAdapter();
    strict_1.default.equal((await adapter.assess({ symbol: "BTCUSDT", side: "BUY", qty: "1", price: "1" })).lossProbability, 0.7);
    wrongSymbol = true;
    await strict_1.default.rejects(adapter.assess({ symbol: "BTCUSDT", side: "BUY", qty: "1", price: "1" }), /contract/);
});
(0, node_test_1.default)("venue positions enforce end-client attribution and stale marks never become paper prices", async (context) => {
    context.mock.method(globalThis, "fetch", async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/instruments"))
            return envelope([instrument]);
        if (url.pathname.endsWith("/mark-price"))
            return envelope({ symbol: instrument.symbol, markPrice: "60000", srcTs: Date.now() - 60_000 });
        strict_1.default.equal(url.searchParams.get("clientUid"), "expected-client");
        return envelope([{ clientUid: "other-client", symbol: instrument.symbol, netQty: "1", avgEntry: "1" }]);
    });
    const adapter = new perpetuals_adapter_1.PerpetualsAdapter(liveConfig);
    await strict_1.default.rejects(adapter.clientPositions("expected-client"), /another client/);
    await strict_1.default.rejects(adapter.quote(instrument.symbol), /Fresh correlated venue marks/);
});
(0, node_test_1.default)("public venue WebSocket subscribes documented channels, handles gaps and closes cleanly", async (context) => {
    const wss = new ws_1.WebSocketServer({ port: 0, host: "127.0.0.1" });
    await (0, node_events_1.once)(wss, "listening");
    const address = wss.address();
    strict_1.default.ok(address && typeof address !== "string");
    const events = [];
    let resync = false;
    let finish = () => { };
    const done = new Promise((resolve) => { finish = resolve; });
    wss.on("connection", (socket) => socket.on("message", (buffer) => {
        const message = JSON.parse(buffer.toString());
        if (message.op === "subscribe") {
            strict_1.default.deepEqual(message.args, ["ticker.BTC-USD-PERP", "markIndex.BTC-USD-PERP", "trades.BTC-USD-PERP", "orderbook.25.BTC-USD-PERP"]);
            socket.send(JSON.stringify({ channel: "ticker.BTC-USD-PERP", data: { lastPrice: "60000" } }));
            socket.send(JSON.stringify({ channel: "orderbook.25.BTC-USD-PERP", type: "snapshot", seq: 1, data: { bids: [], asks: [] } }));
            socket.send(JSON.stringify({ channel: "orderbook.25.BTC-USD-PERP", type: "delta", seq: 3, prevSeq: 2, data: {} }));
        }
        if (message.op === "resync") {
            resync = true;
            finish();
        }
    }));
    const adapter = new perpetuals_adapter_1.PerpetualsAdapter(liveConfig, (url) => {
        strict_1.default.equal(url, "wss://sandbox.mtf.perpetuals.net/ws/public");
        return new ws_1.WebSocket(`ws://127.0.0.1:${address.port}`);
    });
    (0, node_test_1.default)("public feed reconnects with a fresh subscription after a network drop", async (context) => {
        const wss = new ws_1.WebSocketServer({ port: 0, host: "127.0.0.1" });
        await (0, node_events_1.once)(wss, "listening");
        const address = wss.address();
        strict_1.default.ok(address && typeof address !== "string");
        let connections = 0;
        let finish = () => { };
        const recovered = new Promise((resolve) => { finish = resolve; });
        wss.on("connection", (socket) => {
            connections++;
            socket.on("message", (buffer) => {
                if (JSON.parse(buffer.toString()).op !== "subscribe")
                    return;
                if (connections === 1)
                    socket.close();
                else
                    socket.send(JSON.stringify({ channel: `ticker.${instrument.symbol}`, data: { lastPrice: "60000" } }));
            });
        });
        const adapter = new perpetuals_adapter_1.PerpetualsAdapter(liveConfig, () => new ws_1.WebSocket(`ws://127.0.0.1:${address.port}`));
        const stop = adapter.subscribe(instrument.symbol, (event) => { if (event.channel === "quotes")
            finish(); }, () => { });
        context.after(async () => { stop(); for (const socket of wss.clients)
            socket.terminate(); await new Promise((resolve) => wss.close(() => resolve())); });
        await Promise.race([recovered, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Reconnect timed out")), 3000); timer.unref(); })]);
        strict_1.default.equal(connections, 2);
    });
    const stop = adapter.subscribe(instrument.symbol, (event) => { events.push(event); }, (error) => { throw error; });
    context.after(async () => { stop(); for (const client of wss.clients)
        client.terminate(); await new Promise((resolve) => wss.close(() => resolve())); });
    await Promise.race([done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Feed test timed out")), 3000); timer.unref(); })]);
    strict_1.default.equal(resync, true);
    strict_1.default.ok(events.some((event) => event.channel === "quotes"));
    strict_1.default.equal(events.filter((event) => event.channel === "orderbook").length, 1, "Gap delta must not be forwarded as a valid book");
});
(0, node_test_1.default)("PostgreSQL global paper accounting, attribution and unified stream integration", {
    skip: process.env.RUN_DB_TESTS !== "true", timeout: 30_000,
}, async (suite) => {
    strict_1.default.ok(new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_hardening_test"), "Disposable test database required");
    process.env.NODE_ENV = "test";
    process.env.PERPETUALS_ENVIRONMENT = "sandbox";
    process.env.JWT_SECRET = "global-test-jwt-secret-32-random-characters";
    process.env.PII_ENCRYPTION_KEY = "b".repeat(64);
    for (const key of ["PERPETUALS_API_KEY", "PERPETUALS_API_SECRET", "BAYESSHIELD_GATEWAY_URL", "BAYESSHIELD_API_KEY"])
        delete process.env[key];
    const { prisma } = await Promise.resolve().then(() => __importStar(require("../config/prisma")));
    const { app } = await Promise.resolve().then(() => __importStar(require("../app")));
    const { attachUnifiedMarketStream } = await Promise.resolve().then(() => __importStar(require("../services/marketData.service")));
    const { issueAccessToken } = await Promise.resolve().then(() => __importStar(require("../services/auth.service")));
    const { deviceFingerprint } = await Promise.resolve().then(() => __importStar(require("../services/session.service")));
    const { encryptPii } = await Promise.resolve().then(() => __importStar(require("../services/pii.service")));
    const { perpetualsAdapter } = await Promise.resolve().then(() => __importStar(require("../adapters/perpetuals.adapter")));
    const server = app.listen(0, "127.0.0.1");
    const stopStreams = attachUnifiedMarketStream(server);
    await (0, node_events_1.once)(server, "listening");
    const address = server.address();
    strict_1.default.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
        const user = await prisma.user.create({ data: {
                email: encryptPii(`${(0, node_crypto_1.randomUUID)()}@example.com`), firstName: encryptPii("Paper"), lastName: encryptPii("Test"),
                passwordHash: "not-used-in-this-session-fixture", wallet: { create: {} },
            } });
        const device = (0, node_crypto_1.randomUUID)();
        const fingerprint = deviceFingerprint(device, "127.0.0.1");
        const session = await prisma.authSession.create({ data: { userId: user.id, deviceHash: fingerprint, expiresAt: new Date(Date.now() + 3600_000) } });
        const token = issueAccessToken(user.id, session.id, fingerprint);
        let fillPrice = "60000";
        const venue = perpetualsAdapter();
        suite.mock.method(venue, "quote", async (symbol) => ({ symbol, price: fillPrice, at: Date.now(), simulated: true }));
        async function call(path, body, key = (0, node_crypto_1.randomUUID)()) {
            const response = await fetch(`${base}/api/v1/perpetuals${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: { authorization: ["Bearer", token].join(" "), "x-device-id": device, "content-type": "application/json", "idempotency-key": key },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: await response.json() };
        }
        const buy = { symbol: "BTCUSDT", side: "BUY", qty: "0.001", limitPrice: "100000", acknowledgeHighRisk: true };
        await suite.test("new global portfolios contain zero balances, no positions, and no trades", async () => {
            const result = await call("/portfolio");
            strict_1.default.equal(result.status, 200);
            strict_1.default.ok(result.body.data.balances.every((balance) => balance.available === "0.00000000"));
            strict_1.default.deepEqual(result.body.data.positions, []);
            strict_1.default.deepEqual(result.body.data.orders, []);
        });
        await suite.test("funding is explicit, balanced and permanently idempotent without touching NGN", async () => {
            const key = (0, node_crypto_1.randomUUID)();
            const body = { asset: "USD", amount: "100" };
            const first = await call("/paper/fund", body, key);
            strict_1.default.equal(first.status, 201, JSON.stringify(first.body));
            await prisma.idempotencyRecord.deleteMany({});
            strict_1.default.deepEqual((await call("/paper/fund", body, key)).body, first.body);
            strict_1.default.equal((await call("/paper/fund", { ...body, amount: "101" }, key)).status, 409);
            strict_1.default.equal(await prisma.journalEntry.count({ where: { transactions: { some: { ledgerAccount: { userId: user.id } } } } }), 0);
            strict_1.default.equal((await call("/paper/orders", buy)).body.error.code, "PAPER_INSUFFICIENT_BALANCE", "USD cannot fund a USDT order");
        });
        await suite.test("concurrent orders cannot double-spend and unknown risk needs explicit acknowledgment", async () => {
            strict_1.default.equal((await call("/paper/fund", { asset: "USDT", amount: "100" })).status, 201);
            strict_1.default.equal((await call("/paper/orders", { ...buy, acknowledgeHighRisk: false })).body.error.code, "GLOBAL_RISK_ACK_REQUIRED");
            const results = await Promise.all([call("/paper/orders", buy), call("/paper/orders", buy)]);
            strict_1.default.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
            const snapshot = (await call("/portfolio")).body.data;
            strict_1.default.equal(snapshot.balances.find((balance) => balance.asset === "USDT").available, "40.00000000");
            strict_1.default.equal(snapshot.positions[0].qty, "0.00100000");
            strict_1.default.equal(snapshot.orders.length, 1);
            const order = await prisma.globalPaperOrder.findFirstOrThrow({ where: { userId: user.id } });
            const oldPrice = fillPrice;
            fillPrice = "200000";
            strict_1.default.equal((await call("/paper/orders", buy)).body.error.code, "PAPER_LIMIT_NOT_MET");
            fillPrice = oldPrice;
            strict_1.default.equal(order.amount.toFixed(8), "60.00000000");
        });
        await suite.test("partial/full sells book exact cost and realized losses/gains", async () => {
            const sell = { ...buy, side: "SELL", qty: "0.0005", limitPrice: "1" };
            fillPrice = "50000";
            strict_1.default.equal((await call("/paper/orders", sell)).status, 201);
            fillPrice = "70000";
            strict_1.default.equal((await call("/paper/orders", sell)).status, 201);
            const snapshot = (await call("/portfolio")).body.data;
            strict_1.default.equal(snapshot.balances.find((balance) => balance.asset === "USDT").available, "100.00000000");
            strict_1.default.equal(snapshot.positions.length, 0);
            strict_1.default.equal((await call("/paper/orders", sell)).body.error.code, "PAPER_INSUFFICIENT_POSITION");
            fillPrice = "60000";
        });
        await suite.test("order replays survive HTTP cache expiry and do not need fresh prices", async () => {
            const key = (0, node_crypto_1.randomUUID)();
            const first = await call("/paper/orders", buy, key);
            strict_1.default.equal(first.status, 201);
            await prisma.idempotencyRecord.deleteMany({});
            fillPrice = "200000";
            strict_1.default.deepEqual((await call("/paper/orders", buy, key)).body, first.body);
            strict_1.default.equal((await call("/paper/orders", { ...buy, qty: "0.002" }, key)).status, 409);
            fillPrice = "60000";
        });
        await suite.test("perpetual and barrier execution stay disabled and SQL rejects corrupt paper balances", async () => {
            strict_1.default.equal((await call("/paper/orders", { ...buy, symbol: "BTC-USD-PERP" })).body.error.code, "PRODUCT_EXECUTION_DISABLED");
            strict_1.default.equal((await call("/paper/orders", { ...buy, symbol: "SIM-BTC-USD-KO" })).body.error.code, "PRODUCT_EXECUTION_DISABLED");
            await strict_1.default.rejects(prisma.globalPaperJournal.create({ data: { asset: "USD", reference: (0, node_crypto_1.randomUUID)(), requestHash: "test", description: "Orphan" } }));
            const cash = await prisma.globalPaperAccount.findUniqueOrThrow({ where: { userId_asset_code: { userId: user.id, asset: "USDT", code: "CASH" } } });
            await strict_1.default.rejects(prisma.globalPaperAccount.update({ where: { id: cash.id }, data: { balance: "100000" } }));
            const position = await prisma.globalPaperPosition.findFirstOrThrow({ where: { userId: user.id, qty: { gt: 0 } } });
            await strict_1.default.rejects(prisma.globalPaperPosition.update({ where: { id: position.id }, data: { cost: "1" } }));
            const order = await prisma.globalPaperOrder.findFirstOrThrow({ where: { userId: user.id } });
            await strict_1.default.rejects(prisma.globalPaperOrder.update({ where: { id: order.id }, data: { price: "1" } }));
        });
        await suite.test("kill switch blocks global paper funding and preserves read access", async () => {
            await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: true } });
            try {
                strict_1.default.equal((await call("/paper/fund", { asset: "USD", amount: "1" })).body.error.code, "SYSTEM_READ_ONLY");
                strict_1.default.equal((await call("/portfolio")).status, 200);
            }
            finally {
                await prisma.systemControl.update({ where: { id: "global" }, data: { readOnly: false } });
            }
        });
        await suite.test("unified stream authenticates before subscription and emits simulated global frames", async () => {
            const ws = new ws_1.WebSocket(base.replace("http:", "ws:") + "/api/v1/markets/stream");
            const done = new Promise((resolve, reject) => {
                ws.on("open", () => ws.send(JSON.stringify({ op: "auth", token, deviceId: device })));
                ws.on("message", (buffer) => {
                    const message = JSON.parse(buffer.toString());
                    if (message.type === "authenticated")
                        ws.send(JSON.stringify({ op: "subscribe", region: "GLOBAL", symbol: "BTCUSDT" }));
                    if (message.type === "error")
                        reject(new Error(JSON.stringify(message)));
                    if (message.type === "market" && message.event.channel === "quotes") {
                        strict_1.default.equal(message.event.simulated, true);
                        strict_1.default.equal(message.event.region, "GLOBAL");
                        resolve();
                    }
                });
                ws.on("error", reject);
            });
            try {
                await Promise.race([done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Unified stream timed out")), 3000); timer.unref(); })]);
            }
            finally {
                ws.terminate();
            }
        });
        await suite.test("unified stream refuses missing authentication and device-mismatched sessions", async () => {
            for (const payload of [
                { op: "subscribe", region: "GLOBAL", symbol: "BTCUSDT" },
                { op: "auth", token, deviceId: (0, node_crypto_1.randomUUID)() },
            ]) {
                const ws = new ws_1.WebSocket(base.replace("http:", "ws:") + "/api/v1/markets/stream");
                const close = (0, node_events_1.once)(ws, "close");
                ws.on("open", () => ws.send(JSON.stringify(payload)));
                const [code] = await close;
                strict_1.default.equal(code, 1008);
            }
        });
    }
    finally {
        stopStreams();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await prisma.$disconnect();
    }
});
