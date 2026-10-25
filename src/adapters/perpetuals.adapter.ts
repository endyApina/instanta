import { createHmac } from "node:crypto";
import { isDemoMode } from "../config/demo";
import WebSocket from "ws";
import { z } from "zod";
import { AppError } from "../errors/app-error";
import { CircuitBreaker } from "./circuit-breaker";
import { MoneyDecimal as D } from "../domain/money";
import {
  globalSymbol, instrumentSchema, positiveGlobalDecimal,
  type GlobalInstrument, type GlobalMarketEvent,
} from "../domain/perpetuals";

export function signPerpetualsRequest(secret: string, timestamp: string, method: string, pathWithQuery: string, body = "") {
  return createHmac("sha256", secret).update(timestamp + method.toUpperCase() + pathWithQuery + body).digest("hex");
}

const envelopeSchema = z.object({
  code: z.number().int(), data: z.unknown().optional(), ts: z.number().finite(),
});
const markSchema = z.object({ symbol: globalSymbol, markPrice: positiveGlobalDecimal, srcTs: z.number().int().positive() });
export interface PerpetualsQuote { symbol: string; price: string; at: number; simulated: boolean }
export interface PerpetualsConfig {
  environment: "development" | "staging" | "test" | "production";
  venue: "sandbox" | "production";
  key?: string; secret?: string;
}
type SandboxOrder = {
  symbol: string; side: "BUY" | "SELL"; type: "LIMIT"; tif: "IOC";
  qty: string; price: string; clientUid: string; clOrdId: string; quoteCcy: string;
};
const mockInstruments: GlobalInstrument[] = [
  ["BTCUSDT", "SPOT", "BTC", "USDT", "0.01", "0.00001"],
  ["ETHUSDT", "SPOT", "ETH", "USDT", "0.01", "0.0001"],
  ["SIM-AAPLUSD", "SECURITY", "SIM-AAPL", "USD", "0.01", "0.01"],
  ["SIM-XAUUSD", "SPOT", "SIM-XAU", "USD", "0.01", "0.001"],
  ["SIM-INDEXUSD", "SECURITY", "SIM-INDEX", "USD", "0.01", "0.01"],
  ["BTC-USD-PERP", "PERP", "BTC", "USD", "0.5", "0.001"],
  ["SIM-BTC-USD-KO", "BARRIER", "BTC", "USD", "0.5", "0.001"],
].map(([symbol, kind, baseAsset, quoteAsset, tickSize, qtyStep]) => instrumentSchema.parse({
  symbol, kind, baseAsset, quoteAsset, tickSize, qtyStep, minQty: qtyStep,
  settlementCcy: quoteAsset, contractMultiplier: "1", status: "ACTIVE",
  mode: kind === "BARRIER" ? "RFQ" : "ORDER_BOOK",
}));
const mockPrices: Record<string, string> = {
  BTCUSDT: "60000", ETHUSDT: "2500", "SIM-AAPLUSD": "200", "SIM-XAUUSD": "2500",
  "SIM-INDEXUSD": "5000", "BTC-USD-PERP": "60000", "SIM-BTC-USD-KO": "60000",
};

export class PerpetualsAdapter {
  readonly simulated: boolean;
  private readonly breaker = new CircuitBreaker("Perpetuals.com");
  private readonly base: string;
  private catalog: { until: number; instruments: GlobalInstrument[] } | undefined;
  private retryAt = 0;
  constructor(
    private readonly config: PerpetualsConfig,
    private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 1_048_576 }),
  ) {
    if (isDemoMode()) this.config = { ...config, key: undefined, secret: undefined };
    this.simulated = !this.config.key || !this.config.secret;
    if (this.simulated && config.environment === "production") {
      throw new Error("Perpetuals.com credentials are required in production; simulated global markets are disabled");
    }
    if (isDemoMode()) console.warn("\x1b[33m[DEMO] Database-only market feed enabled; external credentials are ignored\x1b[0m");
    else if (this.simulated) console.warn("\x1b[33m[WARN] PERPETUALS.COM API KEY MISSING: Falling back to simulated global market feed\x1b[0m");
    // Sandbox hostname follows the environment landing page/OpenAPI. No caller-supplied hosts receive credentials.
    this.base = config.venue === "production" ? "https://production.mtf.perpetuals.com" : "https://sandbox.mtf.perpetuals.net";
  }

  private async request<T>(method: string, path: string, schema: z.ZodType<T>, body?: object, signed = false): Promise<T> {
    if (isDemoMode()) throw new AppError(403, "DEMO_NETWORK_DISABLED", "External trading connections are disabled in demo mode.");
    if (Date.now() < this.retryAt) throw new AppError(503, "PERPETUALS_RATE_LIMITED", "Venue cooldown is active; retry later");
    if (signed && this.simulated) throw new AppError(503, "PERPETUALS_NOT_CONFIGURED", "Signed venue access requires credentials");
    return this.breaker.execute(async () => {
      const timestamp = String(Date.now());
      const serialized = body === undefined ? "" : JSON.stringify(body);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (signed) {
        headers["X-API-Key"] = this.config.key!;
        headers["X-Timestamp"] = timestamp;
        headers["X-Signature"] = signPerpetualsRequest(this.config.secret!, timestamp, method, path, serialized);
      }
      let response: Response;
      try {
        response = await fetch(this.base + path, {
          method, headers, ...(serialized ? { body: serialized } : {}),
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new AppError(503, method === "GET" ? "PERPETUALS_UNAVAILABLE" : "PERPETUALS_ORDER_UNCERTAIN",
          method === "GET" ? "Global venue is unavailable" : "Sandbox order outcome is uncertain; reconcile the original client order reference before retrying");
      }
      let raw: unknown;
      try { raw = await response.json(); }
      catch { throw new AppError(502, "PERPETUALS_INVALID_RESPONSE", "Venue returned invalid JSON; order outcomes must be reconciled before any retry"); }
      const envelope = envelopeSchema.safeParse(raw);
      if (response.status === 429 || (envelope.success && envelope.data.code === 1003)) {
        const detail = z.object({ retryAfterMs: z.number().finite().nonnegative() }).safeParse(envelope.success ? envelope.data.data : null);
        this.retryAt = Date.now() + Math.min(300_000, detail.success ? Math.max(1, detail.data.retryAfterMs) : 1000);
        throw new AppError(503, "PERPETUALS_RATE_LIMITED", "Venue rate limit reached; no automatic order retry was sent");
      }
      if (!response.ok || !envelope.success || envelope.data.code !== 0) {
        throw new AppError(502, "PERPETUALS_REJECTED", "Venue rejected the request; no automatic order retry was sent");
      }
      const parsed = schema.safeParse(envelope.data.data);
      if (!parsed.success) throw new AppError(502, "PERPETUALS_INVALID_RESPONSE", "Venue payload did not match the documented contract");
      return parsed.data;
    });
  }

  async symbols(): Promise<GlobalInstrument[]> {
    if (isDemoMode()) return (await import("../services/demoMode.service")).demoInstruments();
    if (this.simulated) return mockInstruments.map((instrument) => ({ ...instrument }));
    if (this.catalog && this.catalog.until > Date.now()) return this.catalog.instruments;
    const instruments = await this.request("GET", "/v1/instruments", z.array(instrumentSchema).max(5000));
    if (new Set(instruments.map((item) => item.symbol)).size !== instruments.length) throw new AppError(502, "PERPETUALS_INVALID_RESPONSE", "Duplicate venue symbols");
    this.catalog = { until: Date.now() + 60_000, instruments };
    return instruments;
  }

  async quote(symbol: string): Promise<PerpetualsQuote> {
    if (isDemoMode()) return (await import("../services/demoMode.service")).demoQuote(symbol);
    globalSymbol.parse(symbol);
    const instrument = (await this.symbols()).find((item) => item.symbol === symbol);
    if (!instrument) throw new AppError(404, "GLOBAL_SYMBOL_NOT_FOUND", "Select a symbol from the venue catalog; symbols are not guessed or rewritten");
    if (this.simulated) {
      const step = Math.floor(Date.now() / 1000) % 21 - 10;
      return { symbol, price: new D(mockPrices[symbol]!).mul(new D(1).plus(new D(step).div(1000)))
        .div(instrument.tickSize).round().mul(instrument.tickSize).toFixed(), at: Date.now(), simulated: true };
    }
    const result = await this.request("GET", `/v1/mark-price?symbol=${encodeURIComponent(symbol)}`, markSchema);
    if (result.symbol !== symbol || result.srcTs > Date.now() + 5000 || Date.now() - result.srcTs > 30_000) {
      throw new AppError(503, "GLOBAL_PRICE_STALE", "Fresh correlated venue marks are required");
    }
    return { symbol, price: result.markPrice, at: result.srcTs, simulated: false };
  }

  /** Sandbox-only transport primitive; public Instanta trading routes never call this method. */
  async submitSandboxOrder(order: SandboxOrder) {
    if (this.config.venue !== "sandbox" || this.simulated) throw new AppError(503, "LIVE_TRADING_DISABLED", "Only credentialed sandbox order transport is implemented");
    const result = await this.request("POST", "/v1/orders", z.object({
      clOrdId: z.string(), clientUid: z.string(), symbol: z.string(),
      status: z.enum(["NEW", "PENDING_TRIGGER", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "REJECTED"]),
      rejectCode: z.number().optional(),
    }).passthrough(), order, true);
    if (result.clOrdId !== order.clOrdId || result.clientUid !== order.clientUid || result.symbol !== order.symbol) {
      throw new AppError(502, "PERPETUALS_ORDER_UNCERTAIN", "Venue order correlation failed; reconcile before any retry");
    }
    if (result.status === "REJECTED") throw new AppError(409, "PERPETUALS_ENGINE_REJECTED", `Sandbox engine rejected order (code ${result.rejectCode ?? "unknown"})`);
    return result;
  }

  async clientPositions(clientUid: string) {
    if (this.simulated) return [];
    const rows = await this.request("GET", `/v1/positions/end-clients?clientUid=${encodeURIComponent(clientUid)}`,
      z.array(z.object({ clientUid: z.string(), symbol: z.string(), netQty: z.string(), avgEntry: z.string().optional() })).max(5000), undefined, true);
    if (rows.some((row) => row.clientUid !== clientUid)) throw new AppError(502, "PERPETUALS_ATTRIBUTION_FAILED", "Venue returned positions for another client");
    return rows;
  }

  subscribe(symbol: string, emit: (event: GlobalMarketEvent) => void, onError: (error: AppError) => void): () => void {
    globalSymbol.parse(symbol);
    let stopped = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    const publish = (channel: string, data: unknown) => emit({
      region: "GLOBAL", provider: "PERPETUALS", simulated: this.simulated, symbol, channel,
      receivedAt: new Date().toISOString(), data,
    });
    if (this.simulated || isDemoMode()) {
      const tick = async () => {
        try {
          const quote = await this.quote(symbol);
          if (stopped) return;
          publish("quotes", { lastPrice: quote.price, bestBid: quote.price, bestAsk: quote.price });
          publish("marks", { markPrice: quote.price, indexPrice: quote.price });
          publish("trades", { price: quote.price, qty: "0.001", side: "BUY", ts: quote.at, simulated: true });
          publish("orderbook", { type: "snapshot", bids: [[quote.price, "1"]], asks: [[quote.price, "1"]] });
        } catch {
          onError(new AppError(503, "GLOBAL_FEED_ERROR", "Simulated feed failed"));
        }
      };
      void tick();
      heartbeat = setInterval(() => { void tick(); }, 1000);
      return () => { stopped = true; if (heartbeat) clearInterval(heartbeat); };
    }
    const connect = () => {
      if (stopped) return;
      let lastMessage = Date.now();
      let ready = false;
      let bookSeq: number | undefined;
      socket = this.socketFactory(this.base.replace("https:", "wss:") + "/ws/public");
      const ws = socket;
      ws.on("open", () => {
        ws.send(JSON.stringify({ op: "subscribe", reqId: "instanta-public", args: [
          `ticker.${symbol}`, `markIndex.${symbol}`, `trades.${symbol}`, `orderbook.25.${symbol}`,
        ] }));
      });
      ws.on("message", (buffer) => {
        lastMessage = Date.now();
        let raw: unknown;
        try { raw = JSON.parse(buffer.toString()); }
        catch { onError(new AppError(502, "GLOBAL_FEED_INVALID", "Venue sent malformed feed JSON")); ws.close(); return; }
        const control = z.object({ success: z.boolean().optional(), op: z.string().optional() }).safeParse(raw);
        if (control.success && control.data.success === false) {
          onError(new AppError(503, "GLOBAL_SUBSCRIPTION_REJECTED", "Venue refused the market subscription")); ws.close(); return;
        }
        const frame = z.object({
          channel: z.string(), type: z.string().optional(), data: z.unknown(),
          seq: z.number().int().safe().optional(), prevSeq: z.number().int().safe().optional(),
        }).passthrough().safeParse(raw);
        if (!frame.success) return; // Control acknowledgments/pongs are not market frames.
        const channel = frame.data.channel;
        if (!channel.endsWith(`.${symbol}`)) return;
        if (!ready) { ready = true; attempts = 0; publish("status", { connected: true, reset: true }); }
        if (channel.startsWith("orderbook.")) {
          if (frame.data.type === "snapshot") bookSeq = frame.data.seq;
          else if (bookSeq === undefined || frame.data.prevSeq !== bookSeq) {
            bookSeq = undefined;
            publish("status", { stale: true, reason: "ORDERBOOK_GAP" });
            ws.send(JSON.stringify({ op: "resync", reqId: "instanta-resync", args: [channel] }));
            return;
          } else bookSeq = frame.data.seq;
          // Raw snapshots/deltas only. Consumers must validate CRC32C before constructing an executable book.
          publish("orderbook", { ...frame.data, indicativeOnly: true });
        } else {
          const topic = channel.startsWith("ticker.") ? "quotes" : channel.startsWith("markIndex.") ? "marks" : channel.startsWith("trades.") ? "trades" : null;
          if (topic) publish(topic, frame.data.data);
        }
      });
      ws.on("error", () => { onError(new AppError(503, "GLOBAL_FEED_DISCONNECTED", "Global market socket failed; retrying with backoff")); ws.terminate(); });
      ws.on("close", () => {
        if (heartbeat) clearInterval(heartbeat);
        publish("status", { stale: true, reset: true });
        if (!stopped) timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)));
      });
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 30_000) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping", reqId: "instanta-heartbeat" }));
      }, 10_000);
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      socket?.terminate();
    };
  }
}

let adapter: PerpetualsAdapter | undefined;
export function perpetualsAdapter(): PerpetualsAdapter {
  if (!adapter) {
    const environment = z.enum(["development", "staging", "test", "production"]).parse(process.env.NODE_ENV ?? "development");
    const venue = z.enum(["sandbox", "production"]).parse(process.env.PERPETUALS_ENVIRONMENT ?? "sandbox");
    adapter = new PerpetualsAdapter({
      environment, venue, key: process.env.PERPETUALS_API_KEY, secret: process.env.PERPETUALS_API_SECRET,
    });
  }
  return adapter;
}
