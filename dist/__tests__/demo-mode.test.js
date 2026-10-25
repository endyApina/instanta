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
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const node_http_1 = require("node:http");
const node_test_1 = __importDefault(require("node:test"));
const ws_1 = __importDefault(require("ws"));
(0, node_test_1.default)("isolated PostgreSQL demo never contacts an external provider", {
    skip: process.env.RUN_DEMO_TESTS !== "true", timeout: 30_000,
}, async (suite) => {
    strict_1.default.ok(new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_demo"), "Use a dedicated disposable _demo database");
    process.env.NODE_ENV = "test";
    process.env.IS_DEMO_MODE = "true";
    process.env.JWT_SECRET = "demo-test-key-with-at-least-thirty-two-characters";
    process.env.PII_ENCRYPTION_KEY = "d".repeat(64);
    process.env.PERPETUALS_API_KEY = "configured-but-forbidden";
    process.env.PERPETUALS_API_SECRET = "configured-but-forbidden";
    for (const prefix of ["KYC", "BAAS", "FUND", "SMS", "BAYESSHIELD"]) {
        process.env[`${prefix}_GATEWAY_URL`] = "https://forbidden.invalid";
        process.env[`${prefix}_API_KEY`] = "configured-but-forbidden";
    }
    process.env.NGX_API_TOKEN = "configured-but-forbidden";
    process.env.FMDQ_MARKET_GATEWAY_URL = "https://forbidden.invalid";
    process.env.FMDQ_MARKET_API_KEY = "configured-but-forbidden";
    let networkCalls = 0;
    suite.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("External network access is forbidden in demo"); });
    const { prisma } = await Promise.resolve().then(() => __importStar(require("../config/prisma")));
    await prisma.demoInstrument.updateMany({ where: { symbol: "DEMO-NGX" }, data: { price: "50" } });
    const { app } = await Promise.resolve().then(() => __importStar(require("../app")));
    const { attachUnifiedMarketStream } = await Promise.resolve().then(() => __importStar(require("../services/marketData.service")));
    const { partners, PartnerGateway } = await Promise.resolve().then(() => __importStar(require("../adapters")));
    const { demoQuote } = await Promise.resolve().then(() => __importStar(require("../services/demoMode.service")));
    const { PerpetualsAdapter } = await Promise.resolve().then(() => __importStar(require("../adapters/perpetuals.adapter")));
    const { z } = await Promise.resolve().then(() => __importStar(require("zod")));
    const server = app.listen(0, "127.0.0.1");
    const stop = attachUnifiedMarketStream(server);
    await (0, node_events_1.once)(server, "listening");
    const address = server.address();
    strict_1.default.ok(address && typeof address !== "string");
    const device = (0, node_crypto_1.randomUUID)();
    const identity = (0, node_crypto_1.randomBytes)(32).toString("hex");
    let token = "";
    const call = async (path, body, key = (0, node_crypto_1.randomUUID)()) => new Promise((resolve, reject) => {
        const request = (0, node_http_1.request)({ host: "127.0.0.1", port: address.port, path: `/api/v1${path}`,
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json", "x-device-id": device, "idempotency-key": key,
                ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
            let data = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { data += chunk; });
            response.on("end", () => { try {
                resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) });
            }
            catch (error) {
                reject(error);
            } });
        });
        request.on("error", reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
        await suite.test("demo mode refuses production and databases without an explicit demo name", async () => {
            const { assertDemoConfiguration } = await Promise.resolve().then(() => __importStar(require("../config/demo")));
            const original = process.env.DATABASE_URL;
            try {
                process.env.DATABASE_URL = "postgresql://local:local@127.0.0.1:5432/real";
                strict_1.default.throws(assertDemoConfiguration, /separate database/);
            }
            finally {
                process.env.DATABASE_URL = original;
            }
            process.env.NODE_ENV = "production";
            strict_1.default.throws(assertDemoConfiguration, /production/);
            process.env.NODE_ENV = "test";
        });
        await suite.test("first sign-in seeds NGN and USD exactly once, even under concurrent refresh", async () => {
            const responses = await Promise.all([call("/demo/session", { identity }), call("/demo/session", { identity })]);
            for (const response of responses)
                strict_1.default.equal(response.status, 200, JSON.stringify(response.body));
            token = responses[0].body.data.accessToken;
            const snapshot = await call("/wealth/portfolio");
            strict_1.default.equal(snapshot.body.data.balances.find((balance) => balance.asset === "NGN").available, "5000000.00000000");
            strict_1.default.equal(snapshot.body.data.balances.find((balance) => balance.asset === "USD").available, "10000.00000000");
            strict_1.default.deepEqual(snapshot.body.data.positions, []);
            strict_1.default.deepEqual(snapshot.body.data.orders, []);
            const summary = await call("/wealth/summary");
            const ngnCash = summary.body.data.rows.find((row) => row.name === "NGN cash");
            strict_1.default.ok(ngnCash.history.some((entry) => entry.description.includes("practice funds")));
            strict_1.default.equal((await call("/wealth/paper/fund", { asset: "USD", amount: "100" })).status, 409);
        });
        const buy = { symbol: "DEMO-NGX", side: "BUY", qty: "100", limitPrice: "50", acknowledgeHighRisk: true };
        await suite.test("Nigerian and global products share one catalog and one order interface", async () => {
            const catalog = await call("/wealth/products");
            strict_1.default.equal(catalog.status, 200);
            strict_1.default.ok(catalog.body.data.products.some((item) => item.category === "TREASURY_BILL"));
            strict_1.default.ok(catalog.body.data.products.some((item) => item.category === "CRYPTO"));
            strict_1.default.deepEqual(catalog.body.data.unavailable, []);
            const key = (0, node_crypto_1.randomUUID)();
            const order = await call("/wealth/paper/orders", buy, key);
            strict_1.default.equal(order.status, 201, JSON.stringify(order.body));
            const replay = await call("/wealth/paper/orders", buy, key);
            strict_1.default.equal(replay.body.data.orderId, order.body.data.orderId);
            strict_1.default.equal((await call("/wealth/paper/orders", { ...buy, symbol: "DEMO-STOCKUSD", qty: "5", limitPrice: "200" })).status, 201);
            strict_1.default.equal((await call("/wealth/paper/orders", { ...buy, symbol: "DEMO-MMF", qty: "1000", limitPrice: "1" })).status, 201);
            const snapshot = await call("/wealth/portfolio");
            strict_1.default.equal(snapshot.body.data.positions.length, 3);
            strict_1.default.equal(snapshot.body.data.balances.find((balance) => balance.asset === "NGN").available, "4994000.00000000");
        });
        await suite.test("saved prices drive order limits and the simulated market stream", async () => {
            await prisma.demoInstrument.update({ where: { symbol: "DEMO-NGX" }, data: { price: "55" } });
            strict_1.default.equal((await demoQuote("DEMO-NGX")).price, "55");
            strict_1.default.equal((await call("/wealth/paper/orders", buy)).status, 409);
            const socket = new ws_1.default(`ws://127.0.0.1:${address.port}/api/v1/markets/stream`);
            try {
                await (0, node_events_1.once)(socket, "open");
                const quote = new Promise((resolve, reject) => {
                    socket.on("message", (buffer) => {
                        const frame = JSON.parse(buffer.toString());
                        if (frame.type === "authenticated")
                            socket.send(JSON.stringify({ op: "subscribe", region: "GLOBAL", symbol: "DEMO-NGX" }));
                        if (frame.type === "error")
                            reject(new Error(frame.message));
                        if (frame.type === "market" && frame.event.channel === "quotes")
                            resolve(frame.event.data.lastPrice);
                    });
                });
                socket.send(JSON.stringify({ op: "auth", token, deviceId: device }));
                strict_1.default.equal(await quote, "55");
            }
            finally {
                socket.terminate();
            }
            const adapter = new PerpetualsAdapter({ environment: "test", venue: "sandbox", key: "present", secret: "present" }, () => { networkCalls++; throw new Error("External websocket forbidden"); });
            strict_1.default.equal((await adapter.quote("DEMO-NGX")).price, "55");
        });
        await suite.test("saving moves virtual cash once and keeps the total unchanged", async () => {
            const input = { name: "My demo goal", targetAmount: "100000", initialAmount: "20000", autoSweep: false };
            const key = (0, node_crypto_1.randomUUID)();
            const result = await call("/savings/goals", input, key);
            strict_1.default.equal(result.status, 201, JSON.stringify(result.body));
            strict_1.default.equal((await call("/savings/goals", input, key)).body.data.goal.id, result.body.data.goal.id);
            const summary = await call("/wealth/summary");
            strict_1.default.equal(summary.status, 200);
            strict_1.default.equal(summary.body.data.totals.find((total) => total.currency === "NGN").amount, "5000000");
            strict_1.default.ok(summary.body.data.rows.some((row) => row.name === "My demo goal" && row.history.length));
            const wallet = await call("/dashboard");
            strict_1.default.equal(wallet.body.data.wallet.balance, "0.00");
            strict_1.default.equal(wallet.body.data.goals[0].balance, "20000.00");
        });
        await suite.test("concurrent oversized orders cannot spend the same demo money twice", async () => {
            const input = { ...buy, symbol: "DEMO-STOCKUSD", qty: "30", limitPrice: "200" };
            const orders = await Promise.all([call("/wealth/paper/orders", input), call("/wealth/paper/orders", input)]);
            strict_1.default.deepEqual(orders.map((order) => order.status).sort(), [201, 409]);
        });
        await suite.test("rebalance is local, idempotent and does not cross currencies", async () => {
            const key = (0, node_crypto_1.randomUUID)();
            const rebalance = await call("/demo/rebalance", {}, key);
            strict_1.default.equal(rebalance.status, 200, JSON.stringify(rebalance.body));
            strict_1.default.ok(rebalance.body.data.trades > 0);
            const replay = await call("/demo/rebalance", {}, key);
            strict_1.default.deepEqual(replay.body, rebalance.body);
            const summary = await call("/wealth/summary");
            strict_1.default.deepEqual(summary.body.data.totals.map((total) => total.currency).sort(), ["NGN", "USD"]);
        });
        await suite.test("partner adapters, licensed feeds, notifications and webhooks cannot escape isolation", async () => {
            strict_1.default.equal((await partners().baas.createAccount("demo-user")).simulated, true);
            strict_1.default.equal((await partners().kyc.verify({ userId: "demo-user", reference: "demo", bvn: "00000000000" })).simulated, true);
            strict_1.default.equal((await partners().fund.placeBatch("demo", [{ id: "demo", asset: "MMF", amount: "100" }]))[0]?.simulated, true);
            await partners().notifications.sendOtp("demo", "not-a-destination", "000000");
            await strict_1.default.rejects(new PartnerGateway("test", "https://forbidden.invalid", "key").post("key", {}, z.unknown()), /disabled in demo/);
            strict_1.default.equal((await call("/markets/instruments?provider=NGX")).status, 200);
            strict_1.default.equal((await call("/markets/history?provider=NGX&symbol=DEMO-NGX&range=1M")).status, 200);
            strict_1.default.equal((await call("/markets/instruments?provider=FMDQ")).status, 200);
            strict_1.default.equal((await call("/webhooks/baas", {})).status, 403);
            strict_1.default.equal((await call("/webhooks/kyc", {})).status, 403);
            strict_1.default.equal(networkCalls, 0, "No fetch or external WebSocket connection is permitted, even with credentials set");
        });
    }
    finally {
        stop();
        await new Promise((resolve) => server.close(() => resolve()));
        await prisma.$disconnect();
    }
});
