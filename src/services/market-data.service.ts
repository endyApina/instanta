import { z } from "zod";
import { CircuitBreaker } from "../adapters/circuit-breaker";
import { AppError } from "../errors/app-error";
import { marketCatalogSchema, marketHistorySchema, type MarketProvider, type MarketRange } from "../domain/market-data";
import { MoneyDecimal as D } from "../domain/money";
import { isDemoMode } from "../config/demo";
import { prisma } from "../config/prisma";

const quoteSchema = z.array(z.object({
  Symbol: z.string(), Asset: z.string(), Currency: z.string(),
})).max(3000);
const finitePrice = z.number().finite().nonnegative().max(1e15);
const historyRowsSchema = z.array(z.tuple([
  z.number().finite(), finitePrice, finitePrice, finitePrice, finitePrice, z.number().finite().nonnegative(),
])).max(4000);

export class MarketDataService {
  private readonly breakers = { NGX: new CircuitBreaker("NGX market data"), FMDQ: new CircuitBreaker("FMDQ market data") };
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  private async cached<T>(key: string, schema: z.ZodType<T>, load: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return schema.parse(cached.value);
    const pending = this.pending.get(key);
    if (pending) return schema.parse(await pending);
    if (this.pending.size >= 128) throw new AppError(503, "MARKET_DATA_BUSY", "Market data is busy; retry shortly");
    const task = load().then((value) => {
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, expiresAt: Date.now() + 60_000 });
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }

  private async json(url: URL, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch {
      // Never log the URL: NGX authenticates with a secret query parameter.
      throw new AppError(503, "MARKET_DATA_UNAVAILABLE", "Market data provider could not be reached");
    }
    if (!response.ok) throw new AppError(502, "MARKET_DATA_REJECTED", `Market data provider returned HTTP ${response.status}; check subscription entitlements`);
    try { return await response.json(); }
    catch { throw new AppError(502, "MARKET_DATA_INVALID", "Market data provider returned invalid JSON"); }
  }

  private async ngx(path: string, params: Record<string, string>): Promise<unknown> {
    const token = process.env.NGX_API_TOKEN;
    if (!token) throw new AppError(503, "MARKET_DATA_NOT_CONFIGURED", "NGX prices are not connected yet. Please contact support if you need access.");
    const url = new URL(`https://marketdataapiv3.ngxgroup.com/v3/api/${path}.json`);
    for (const [key, value] of Object.entries({ ...params, _t: token })) url.searchParams.set(key, value);
    return this.json(url);
  }

  private async fmdq(body: object): Promise<unknown> {
    const endpoint = process.env.FMDQ_MARKET_GATEWAY_URL;
    const key = process.env.FMDQ_MARKET_API_KEY;
    if (!endpoint || !key) throw new AppError(503, "MARKET_DATA_NOT_CONFIGURED", "FMDQ rates are not connected yet. Please contact support if you need access.");
    let url: URL;
    try { url = new URL(endpoint); }
    catch { throw new AppError(503, "MARKET_DATA_CONFIG_INVALID", "FMDQ market gateway URL is invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new AppError(503, "MARKET_DATA_CONFIG_INVALID", "FMDQ market gateway requires HTTPS without embedded credentials or a fragment");
    }
    return this.json(url, { method: "POST", headers: {
      "content-type": "application/json", authorization: ["Bearer", key].join(" "),
    }, body: JSON.stringify(body) });
  }

  async catalog(provider: MarketProvider) {
    if (isDemoMode()) {
      const rows = await prisma.demoInstrument.findMany({ where: { category: { in: provider === "NGX" ? ["EQUITY", "ETF"] : ["TREASURY_BILL"] } } });
      return marketCatalogSchema.parse({ provider, instruments: rows.map((row) => ({
        symbol: row.symbol, name: row.name, category: row.category, unit: "NGN",
      })) });
    }
    return this.cached(`catalog:${provider}`, marketCatalogSchema, () => this.breakers[provider].execute(async () => {
      let raw: unknown;
      if (provider === "NGX") {
        const quotes = quoteSchema.safeParse(await this.ngx("quote/stockquotes", {}));
        if (!quotes.success) throw new AppError(502, "MARKET_DATA_INVALID", "NGX quote catalog did not match the documented contract");
        raw = { provider, instruments: quotes.data.filter((row) => ["EQUITY", "ETF"].includes(row.Asset) && row.Currency === "NGN")
          .map((row) => ({ symbol: row.Symbol, name: row.Symbol, category: row.Asset, unit: "NGN" })) };
      } else raw = await this.fmdq({ operation: "instruments" });
      const parsed = marketCatalogSchema.safeParse(raw);
      if (!parsed.success || parsed.data.provider !== provider || parsed.data.instruments.some((item) =>
        provider === "FMDQ" && !["TREASURY_BILL", "FGN_BOND", "RATE"].includes(item.category))) {
        throw new AppError(502, "MARKET_DATA_INVALID", "Market instrument catalog did not match the provider contract");
      }
      return parsed.data;
    }));
  }

  async history(provider: MarketProvider, symbol: string, range: MarketRange) {
    const catalog = await this.catalog(provider);
    const instrument = catalog.instruments.find((item) => item.symbol === symbol);
    if (!instrument) throw new AppError(404, "MARKET_INSTRUMENT_NOT_FOUND", "Select an instrument available under your market data subscription");
    if (isDemoMode()) {
      const row = await prisma.demoInstrument.findUniqueOrThrow({ where: { symbol } });
      return marketHistorySchema.parse({ provider, symbol, unit: "NGN", frequency: "END_OF_DAY", fetchedAt: new Date().toISOString(),
        points: [{ at: row.updatedAt.toISOString(), value: row.price.toFixed() }] });
    }
    const end = new Date();
    const start = new Date(end.getTime() - ({ "1M": 30, "3M": 90, "1Y": 365 }[range]) * 86_400_000);
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    return this.cached(`history:${provider}:${symbol}:${range}:${to}`, marketHistorySchema, () => this.breakers[provider].execute(async () => {
      let raw: unknown;
      if (provider === "NGX") {
        const rows = historyRowsSchema.safeParse(await this.ngx("price/interdayprices", { s: symbol, f: from, t: to }));
        if (!rows.success) throw new AppError(502, "MARKET_DATA_INVALID", "NGX historical prices did not match the documented OHLCV contract");
        raw = { provider, symbol, unit: instrument.unit, frequency: "END_OF_DAY", fetchedAt: new Date().toISOString(),
          points: rows.data.map((row) => {
            // NGX returns .NET ticks (100ns since year 1), not Unix milliseconds.
            const milliseconds = new D(row[0].toString()).minus("621355968000000000").div(10000).round().toNumber();
            const date = new Date(milliseconds);
            if (!Number.isFinite(date.getTime())) throw new AppError(502, "MARKET_DATA_INVALID", "NGX returned an invalid observation date");
            return { at: date.toISOString(), value: new D(row[4].toString()).toFixed() };
          }).sort((a, b) => a.at.localeCompare(b.at)) };
      } else raw = await this.fmdq({ operation: "history", symbol, from, to });
      const parsed = marketHistorySchema.safeParse(raw);
      if (!parsed.success || parsed.data.provider !== provider || parsed.data.symbol !== symbol || parsed.data.unit !== instrument.unit
        || parsed.data.points.some((point) => point.at.slice(0, 10) < from || point.at.slice(0, 10) > to || Date.parse(point.at) > end.getTime())
        || (provider === "NGX" && parsed.data.frequency !== "END_OF_DAY")) {
        throw new AppError(502, "MARKET_DATA_INVALID", "Market history did not match the requested instrument, units or date range");
      }
      return parsed.data;
    }));
  }
}

export const marketData = new MarketDataService();
