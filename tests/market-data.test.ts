import assert from "node:assert/strict";
import test from "node:test";
import { MarketDataService } from "../src/services/market-data.service";
import { marketHistorySchema } from "../src/domain/market-data";

const quotes = [
  { Symbol: "DANGCEM", Asset: "EQUITY", Currency: "NGN" },
  { Symbol: "ETF-TEST", Asset: "ETF", Currency: "NGN" },
  { Symbol: "DEBT-TEST", Asset: "DEBT", Currency: "NGN" },
];
function day(offset: number) {
  const now = new Date(Date.now() - offset * 86_400_000);
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}
function ticks(at: string) {
  return Number(BigInt(Date.parse(at)) * 10000n + 621355968000000000n);
}

test("NGX uses server-side token, discovers equities/ETFs and normalizes .NET tick history", async (context) => {
  const previous = process.env.NGX_API_TOKEN;
  process.env.NGX_API_TOKEN = "test-token-never-in-response";
  context.after(() => { if (previous === undefined) delete process.env.NGX_API_TOKEN; else process.env.NGX_API_TOKEN = previous; });
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://marketdataapiv3.ngxgroup.com");
    assert.equal(url.searchParams.get("_t"), "test-token-never-in-response");
    if (url.pathname.includes("stockquotes")) return Response.json(quotes);
    assert.equal(url.searchParams.get("s"), "DANGCEM");
    assert.match(url.searchParams.get("f")!, /^\d{4}-\d{2}-\d{2}$/);
    return Response.json([[ticks(day(1)), 20, 21, 19, 20.5, 100], [ticks(day(2)), 18, 20, 18, 19.2, 200]]);
  });
  const service = new MarketDataService();
  const catalog = await service.catalog("NGX");
  assert.deepEqual(catalog.instruments.map((item) => item.category), ["EQUITY", "ETF"]);
  const [history, concurrent] = await Promise.all([
    service.history("NGX", "DANGCEM", "1M"), service.history("NGX", "DANGCEM", "1M"),
  ]);
  assert.deepEqual(history, concurrent);
  assert.deepEqual(history.points, [{ at: day(2), value: "19.2" }, { at: day(1), value: "20.5" }]);
  assert.equal(history.unit, "NGN");
  assert.equal(history.frequency, "END_OF_DAY");
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(history).includes(process.env.NGX_API_TOKEN!));
  await assert.rejects(service.history("NGX", "UNKNOWN", "1M"), /Select an instrument/);
});

test("unconfigured feeds do not generate sample data or call providers", async (context) => {
  const values = ["NGX_API_TOKEN", "FMDQ_MARKET_GATEWAY_URL", "FMDQ_MARKET_API_KEY"].map((key) => [key, process.env[key]] as const);
  for (const [key] of values) delete process.env[key];
  context.after(() => { for (const [key, value] of values) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Must not call an unconfigured provider"); });
  const service = new MarketDataService();
  await assert.rejects(service.catalog("NGX"), /NGX prices are not connected yet/);
  await assert.rejects(service.catalog("FMDQ"), /FMDQ rates are not connected yet/);
});

test("FMDQ validates instrument units and preserves fixings separately from prices", async (context) => {
  const previousUrl = process.env.FMDQ_MARKET_GATEWAY_URL;
  const previousKey = process.env.FMDQ_MARKET_API_KEY;
  process.env.FMDQ_MARKET_GATEWAY_URL = "https://feed.example.invalid/fmdq";
  process.env.FMDQ_MARKET_API_KEY = "test-key";
  context.after(() => {
    if (previousUrl === undefined) delete process.env.FMDQ_MARKET_GATEWAY_URL; else process.env.FMDQ_MARKET_GATEWAY_URL = previousUrl;
    if (previousKey === undefined) delete process.env.FMDQ_MARKET_API_KEY; else process.env.FMDQ_MARKET_API_KEY = previousKey;
  });
  let wrongUnit = false;
  context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.operation === "instruments") return Response.json({ provider: "FMDQ", instruments: [
      { symbol: "TEST-NITTY", name: "Test fixing", category: "TREASURY_BILL", unit: "PERCENT" },
    ] });
    return Response.json({
      provider: "FMDQ", symbol: "TEST-NITTY", unit: wrongUnit ? "NGN" : "PERCENT",
      frequency: "FIXING", fetchedAt: new Date().toISOString(), points: [{ at: day(1), value: "18.125" }],
    });
  });
  assert.equal((await new MarketDataService().history("FMDQ", "TEST-NITTY", "1M")).points[0]?.value, "18.125");
  wrongUnit = true;
  await assert.rejects(new MarketDataService().history("FMDQ", "TEST-NITTY", "1M"), /units or date range/);
});

test("history rejects malformed, duplicate and unsorted observations; empty history is valid", () => {
  const base = { provider: "NGX", symbol: "DANGCEM", unit: "NGN", frequency: "END_OF_DAY", fetchedAt: day(0) };
  assert.ok(marketHistorySchema.safeParse({ ...base, points: [] }).success);
  assert.ok(!marketHistorySchema.safeParse({ ...base, points: [{ at: day(1), value: "NaN" }] }).success);
  assert.ok(!marketHistorySchema.safeParse({ ...base, points: [{ at: day(1), value: "1" }, { at: day(2), value: "2" }] }).success);
  assert.ok(!marketHistorySchema.safeParse({ ...base, points: [{ at: day(1), value: "1" }, { at: day(1), value: "2" }] }).success);
});
