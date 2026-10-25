import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import WebSocket from "ws";

test("isolated PostgreSQL demo never contacts an external provider", {
  skip: process.env.RUN_DEMO_TESTS !== "true", timeout: 30_000,
}, async (suite) => {
  assert.ok(new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_demo"), "Use a dedicated disposable _demo database");
  process.env.NODE_ENV = "test"; process.env.IS_DEMO_MODE = "true";
  process.env.JWT_SECRET = "demo-test-key-with-at-least-thirty-two-characters";
  process.env.PII_ENCRYPTION_KEY = "d".repeat(64);
  process.env.PERPETUALS_API_KEY = "configured-but-forbidden"; process.env.PERPETUALS_API_SECRET = "configured-but-forbidden";
  for (const prefix of ["KYC", "BAAS", "FUND", "SMS", "BAYESSHIELD"]) {
    process.env[`${prefix}_GATEWAY_URL`] = "https://forbidden.invalid";
    process.env[`${prefix}_API_KEY`] = "configured-but-forbidden";
  }
  process.env.NGX_API_TOKEN = "configured-but-forbidden";
  process.env.FMDQ_MARKET_GATEWAY_URL = "https://forbidden.invalid";
  process.env.FMDQ_MARKET_API_KEY = "configured-but-forbidden";
  let networkCalls = 0;
  suite.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("External network access is forbidden in demo"); });
  const { prisma } = await import("../config/prisma");
  await prisma.demoInstrument.updateMany({ where: { symbol: "DEMO-NGX" }, data: { price: "50" } });
  const { app } = await import("../app");
  const { attachUnifiedMarketStream } = await import("../services/marketData.service");
  const { partners, PartnerGateway } = await import("../adapters");
  const { demoQuote } = await import("../services/demoMode.service");
  const { PerpetualsAdapter } = await import("../adapters/perpetuals.adapter");
  const { z } = await import("zod");
  const server = app.listen(0, "127.0.0.1");
  const stop = attachUnifiedMarketStream(server);
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const device = randomUUID();
  const identity = randomBytes(32).toString("hex");
  let token = "";
  const call = async (path: string, body?: unknown, key = randomUUID()) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: address.port, path: `/api/v1${path}`,
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-device-id": device, "idempotency-key": key,
        ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
      let data = ""; response.setEncoding("utf8");
      response.on("data", (chunk: string) => { data += chunk; });
      response.on("end", () => { try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) }); } catch (error) { reject(error); } });
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    await suite.test("demo mode refuses production and databases without an explicit demo name", async () => {
      const { assertDemoConfiguration } = await import("../config/demo");
      const original = process.env.DATABASE_URL;
      try {
        process.env.DATABASE_URL = "postgresql://local:local@127.0.0.1:5432/real";
        assert.throws(assertDemoConfiguration, /separate database/);
      } finally { process.env.DATABASE_URL = original; }
      process.env.NODE_ENV = "production";
      assert.throws(assertDemoConfiguration, /production/);
      process.env.NODE_ENV = "test";
    });
    await suite.test("first sign-in seeds NGN and USD exactly once, even under concurrent refresh", async () => {
      const responses = await Promise.all([call("/demo/session", { identity }), call("/demo/session", { identity })]);
      for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.body));
      token = responses[0]!.body.data.accessToken;
      const snapshot = await call("/wealth/portfolio");
      assert.equal(snapshot.body.data.balances.find((balance: { asset: string }) => balance.asset === "NGN").available, "5000000.00000000");
      assert.equal(snapshot.body.data.balances.find((balance: { asset: string }) => balance.asset === "USD").available, "10000.00000000");
      assert.deepEqual(snapshot.body.data.positions, []);
      assert.deepEqual(snapshot.body.data.orders, []);
      const summary = await call("/wealth/summary");
      const ngnCash = summary.body.data.rows.find((row: { name: string }) => row.name === "NGN cash");
      assert.ok(ngnCash.history.some((entry: { description: string }) => entry.description.includes("practice funds")));
      assert.equal((await call("/wealth/paper/fund", { asset: "USD", amount: "100" })).status, 409);
    });
    const buy = { symbol: "DEMO-NGX", side: "BUY", qty: "100", limitPrice: "50", acknowledgeHighRisk: true };
    await suite.test("Nigerian and global products share one catalog and one order interface", async () => {
      const catalog = await call("/wealth/products");
      assert.equal(catalog.status, 200);
      assert.ok(catalog.body.data.products.some((item: { category: string }) => item.category === "TREASURY_BILL"));
      assert.ok(catalog.body.data.products.some((item: { category: string }) => item.category === "CRYPTO"));
      assert.deepEqual(catalog.body.data.unavailable, []);
      const key = randomUUID();
      const order = await call("/wealth/paper/orders", buy, key);
      assert.equal(order.status, 201, JSON.stringify(order.body));
      const replay = await call("/wealth/paper/orders", buy, key);
      assert.equal(replay.body.data.orderId, order.body.data.orderId);
      assert.equal((await call("/wealth/paper/orders", { ...buy, symbol: "DEMO-STOCKUSD", qty: "5", limitPrice: "200" })).status, 201);
      assert.equal((await call("/wealth/paper/orders", { ...buy, symbol: "DEMO-MMF", qty: "1000", limitPrice: "1" })).status, 201);
      const snapshot = await call("/wealth/portfolio");
      assert.equal(snapshot.body.data.positions.length, 3);
      assert.equal(snapshot.body.data.balances.find((balance: { asset: string }) => balance.asset === "NGN").available, "4994000.00000000");
    });
    await suite.test("saved prices drive order limits and the simulated market stream", async () => {
      await prisma.demoInstrument.update({ where: { symbol: "DEMO-NGX" }, data: { price: "55" } });
      assert.equal((await demoQuote("DEMO-NGX")).price, "55");
      assert.equal((await call("/wealth/paper/orders", buy)).status, 409);
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/markets/stream`);
      try {
        await once(socket, "open");
        const quote = new Promise<string>((resolve, reject) => {
          socket.on("message", (buffer) => {
            const frame = JSON.parse(buffer.toString());
            if (frame.type === "authenticated") socket.send(JSON.stringify({ op: "subscribe", region: "GLOBAL", symbol: "DEMO-NGX" }));
            if (frame.type === "error") reject(new Error(frame.message));
            if (frame.type === "market" && frame.event.channel === "quotes") resolve(frame.event.data.lastPrice);
          });
        });
        socket.send(JSON.stringify({ op: "auth", token, deviceId: device }));
        assert.equal(await quote, "55");
      } finally { socket.terminate(); }
      const adapter = new PerpetualsAdapter({ environment: "test", venue: "sandbox", key: "present", secret: "present" },
        () => { networkCalls++; throw new Error("External websocket forbidden"); });
      assert.equal((await adapter.quote("DEMO-NGX")).price, "55");
    });
    await suite.test("saving moves virtual cash once and keeps the total unchanged", async () => {
      const input = { name: "My demo goal", targetAmount: "100000", initialAmount: "20000", autoSweep: false };
      const key = randomUUID();
      const result = await call("/savings/goals", input, key);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal((await call("/savings/goals", input, key)).body.data.goal.id, result.body.data.goal.id);
      const summary = await call("/wealth/summary");
      assert.equal(summary.status, 200);
      assert.equal(summary.body.data.totals.find((total: { currency: string }) => total.currency === "NGN").amount, "5000000");
      assert.ok(summary.body.data.rows.some((row: { name: string; history: unknown[] }) => row.name === "My demo goal" && row.history.length));
      const wallet = await call("/dashboard");
      assert.equal(wallet.body.data.wallet.balance, "0.00");
      assert.equal(wallet.body.data.goals[0].balance, "20000.00");
    });
    await suite.test("concurrent oversized orders cannot spend the same demo money twice", async () => {
      const input = { ...buy, symbol: "DEMO-STOCKUSD", qty: "30", limitPrice: "200" };
      const orders = await Promise.all([call("/wealth/paper/orders", input), call("/wealth/paper/orders", input)]);
      assert.deepEqual(orders.map((order) => order.status).sort(), [201, 409]);
    });
    await suite.test("rebalance is local, idempotent and does not cross currencies", async () => {
      const key = randomUUID();
      const rebalance = await call("/demo/rebalance", {}, key);
      assert.equal(rebalance.status, 200, JSON.stringify(rebalance.body));
      assert.ok(rebalance.body.data.trades > 0);
      const replay = await call("/demo/rebalance", {}, key);
      assert.deepEqual(replay.body, rebalance.body);
      const summary = await call("/wealth/summary");
      assert.deepEqual(summary.body.data.totals.map((total: { currency: string }) => total.currency).sort(), ["NGN", "USD"]);
    });
    await suite.test("partner adapters, licensed feeds, notifications and webhooks cannot escape isolation", async () => {
      assert.equal((await partners().baas.createAccount("demo-user")).simulated, true);
      assert.equal((await partners().kyc.verify({ userId: "demo-user", reference: "demo", bvn: "00000000000" })).simulated, true);
      assert.equal((await partners().fund.placeBatch("demo", [{ id: "demo", asset: "MMF", amount: "100" }]))[0]?.simulated, true);
      await partners().notifications.sendOtp("demo", "not-a-destination", "000000");
      await assert.rejects(new PartnerGateway("test", "https://forbidden.invalid", "key").post("key", {}, z.unknown()), /disabled in demo/);
      assert.equal((await call("/markets/instruments?provider=NGX")).status, 200);
      assert.equal((await call("/markets/history?provider=NGX&symbol=DEMO-NGX&range=1M")).status, 200);
      assert.equal((await call("/markets/instruments?provider=FMDQ")).status, 200);
      assert.equal((await call("/webhooks/baas", {})).status, 403);
      assert.equal((await call("/webhooks/kyc", {})).status, 403);
      assert.equal(networkCalls, 0, "No fetch or external WebSocket connection is permitted, even with credentials set");
    });
  } finally {
    stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
});
