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
exports.PerpetualsAdapter = void 0;
exports.signPerpetualsRequest = signPerpetualsRequest;
exports.perpetualsAdapter = perpetualsAdapter;
const node_crypto_1 = require("node:crypto");
const demo_1 = require("../config/demo");
const ws_1 = __importDefault(require("ws"));
const zod_1 = require("zod");
const app_error_1 = require("../errors/app-error");
const circuit_breaker_1 = require("./circuit-breaker");
const money_1 = require("../domain/money");
const perpetuals_1 = require("../domain/perpetuals");
function signPerpetualsRequest(secret, timestamp, method, pathWithQuery, body = "") {
    return (0, node_crypto_1.createHmac)("sha256", secret).update(timestamp + method.toUpperCase() + pathWithQuery + body).digest("hex");
}
const envelopeSchema = zod_1.z.object({
    code: zod_1.z.number().int(), data: zod_1.z.unknown().optional(), ts: zod_1.z.number().finite(),
});
const markSchema = zod_1.z.object({ symbol: perpetuals_1.globalSymbol, markPrice: perpetuals_1.positiveGlobalDecimal, srcTs: zod_1.z.number().int().positive() });
const mockInstruments = [
    ["BTCUSDT", "SPOT", "BTC", "USDT", "0.01", "0.00001"],
    ["ETHUSDT", "SPOT", "ETH", "USDT", "0.01", "0.0001"],
    ["SIM-AAPLUSD", "SECURITY", "SIM-AAPL", "USD", "0.01", "0.01"],
    ["SIM-XAUUSD", "SPOT", "SIM-XAU", "USD", "0.01", "0.001"],
    ["SIM-INDEXUSD", "SECURITY", "SIM-INDEX", "USD", "0.01", "0.01"],
    ["BTC-USD-PERP", "PERP", "BTC", "USD", "0.5", "0.001"],
    ["SIM-BTC-USD-KO", "BARRIER", "BTC", "USD", "0.5", "0.001"],
].map(([symbol, kind, baseAsset, quoteAsset, tickSize, qtyStep]) => perpetuals_1.instrumentSchema.parse({
    symbol, kind, baseAsset, quoteAsset, tickSize, qtyStep, minQty: qtyStep,
    settlementCcy: quoteAsset, contractMultiplier: "1", status: "ACTIVE",
    mode: kind === "BARRIER" ? "RFQ" : "ORDER_BOOK",
}));
const mockPrices = {
    BTCUSDT: "60000", ETHUSDT: "2500", "SIM-AAPLUSD": "200", "SIM-XAUUSD": "2500",
    "SIM-INDEXUSD": "5000", "BTC-USD-PERP": "60000", "SIM-BTC-USD-KO": "60000",
};
class PerpetualsAdapter {
    config;
    socketFactory;
    simulated;
    breaker = new circuit_breaker_1.CircuitBreaker("Perpetuals.com");
    base;
    catalog;
    retryAt = 0;
    constructor(config, socketFactory = (url) => new ws_1.default(url, { handshakeTimeout: 10_000, maxPayload: 1_048_576 })) {
        this.config = config;
        this.socketFactory = socketFactory;
        if ((0, demo_1.isDemoMode)())
            this.config = { ...config, key: undefined, secret: undefined };
        this.simulated = !this.config.key || !this.config.secret;
        if (this.simulated && config.environment === "production") {
            throw new Error("Perpetuals.com credentials are required in production; simulated global markets are disabled");
        }
        if ((0, demo_1.isDemoMode)())
            console.warn("\x1b[33m[DEMO] Database-only market feed enabled; external credentials are ignored\x1b[0m");
        else if (this.simulated)
            console.warn("\x1b[33m[WARN] PERPETUALS.COM API KEY MISSING: Falling back to simulated global market feed\x1b[0m");
        // Sandbox hostname follows the environment landing page/OpenAPI. No caller-supplied hosts receive credentials.
        this.base = config.venue === "production" ? "https://production.mtf.perpetuals.com" : "https://sandbox.mtf.perpetuals.net";
    }
    async request(method, path, schema, body, signed = false) {
        if ((0, demo_1.isDemoMode)())
            throw new app_error_1.AppError(403, "DEMO_NETWORK_DISABLED", "External trading connections are disabled in demo mode.");
        if (Date.now() < this.retryAt)
            throw new app_error_1.AppError(503, "PERPETUALS_RATE_LIMITED", "Venue cooldown is active; retry later");
        if (signed && this.simulated)
            throw new app_error_1.AppError(503, "PERPETUALS_NOT_CONFIGURED", "Signed venue access requires credentials");
        return this.breaker.execute(async () => {
            const timestamp = String(Date.now());
            const serialized = body === undefined ? "" : JSON.stringify(body);
            const headers = { "content-type": "application/json" };
            if (signed) {
                headers["X-API-Key"] = this.config.key;
                headers["X-Timestamp"] = timestamp;
                headers["X-Signature"] = signPerpetualsRequest(this.config.secret, timestamp, method, path, serialized);
            }
            let response;
            try {
                response = await fetch(this.base + path, {
                    method, headers, ...(serialized ? { body: serialized } : {}),
                    redirect: "error", signal: AbortSignal.timeout(10_000),
                });
            }
            catch {
                throw new app_error_1.AppError(503, method === "GET" ? "PERPETUALS_UNAVAILABLE" : "PERPETUALS_ORDER_UNCERTAIN", method === "GET" ? "Global venue is unavailable" : "Sandbox order outcome is uncertain; reconcile the original client order reference before retrying");
            }
            let raw;
            try {
                raw = await response.json();
            }
            catch {
                throw new app_error_1.AppError(502, "PERPETUALS_INVALID_RESPONSE", "Venue returned invalid JSON; order outcomes must be reconciled before any retry");
            }
            const envelope = envelopeSchema.safeParse(raw);
            if (response.status === 429 || (envelope.success && envelope.data.code === 1003)) {
                const detail = zod_1.z.object({ retryAfterMs: zod_1.z.number().finite().nonnegative() }).safeParse(envelope.success ? envelope.data.data : null);
                this.retryAt = Date.now() + Math.min(300_000, detail.success ? Math.max(1, detail.data.retryAfterMs) : 1000);
                throw new app_error_1.AppError(503, "PERPETUALS_RATE_LIMITED", "Venue rate limit reached; no automatic order retry was sent");
            }
            if (!response.ok || !envelope.success || envelope.data.code !== 0) {
                throw new app_error_1.AppError(502, "PERPETUALS_REJECTED", "Venue rejected the request; no automatic order retry was sent");
            }
            const parsed = schema.safeParse(envelope.data.data);
            if (!parsed.success)
                throw new app_error_1.AppError(502, "PERPETUALS_INVALID_RESPONSE", "Venue payload did not match the documented contract");
            return parsed.data;
        });
    }
    async symbols() {
        if ((0, demo_1.isDemoMode)())
            return (await Promise.resolve().then(() => __importStar(require("../services/demoMode.service")))).demoInstruments();
        if (this.simulated)
            return mockInstruments.map((instrument) => ({ ...instrument }));
        if (this.catalog && this.catalog.until > Date.now())
            return this.catalog.instruments;
        const instruments = await this.request("GET", "/v1/instruments", zod_1.z.array(perpetuals_1.instrumentSchema).max(5000));
        if (new Set(instruments.map((item) => item.symbol)).size !== instruments.length)
            throw new app_error_1.AppError(502, "PERPETUALS_INVALID_RESPONSE", "Duplicate venue symbols");
        this.catalog = { until: Date.now() + 60_000, instruments };
        return instruments;
    }
    async quote(symbol) {
        if ((0, demo_1.isDemoMode)())
            return (await Promise.resolve().then(() => __importStar(require("../services/demoMode.service")))).demoQuote(symbol);
        perpetuals_1.globalSymbol.parse(symbol);
        const instrument = (await this.symbols()).find((item) => item.symbol === symbol);
        if (!instrument)
            throw new app_error_1.AppError(404, "GLOBAL_SYMBOL_NOT_FOUND", "Select a symbol from the venue catalog; symbols are not guessed or rewritten");
        if (this.simulated) {
            const step = Math.floor(Date.now() / 1000) % 21 - 10;
            return { symbol, price: new money_1.MoneyDecimal(mockPrices[symbol]).mul(new money_1.MoneyDecimal(1).plus(new money_1.MoneyDecimal(step).div(1000)))
                    .div(instrument.tickSize).round().mul(instrument.tickSize).toFixed(), at: Date.now(), simulated: true };
        }
        const result = await this.request("GET", `/v1/mark-price?symbol=${encodeURIComponent(symbol)}`, markSchema);
        if (result.symbol !== symbol || result.srcTs > Date.now() + 5000 || Date.now() - result.srcTs > 30_000) {
            throw new app_error_1.AppError(503, "GLOBAL_PRICE_STALE", "Fresh correlated venue marks are required");
        }
        return { symbol, price: result.markPrice, at: result.srcTs, simulated: false };
    }
    /** Sandbox-only transport primitive; public Instanta trading routes never call this method. */
    async submitSandboxOrder(order) {
        if (this.config.venue !== "sandbox" || this.simulated)
            throw new app_error_1.AppError(503, "LIVE_TRADING_DISABLED", "Only credentialed sandbox order transport is implemented");
        const result = await this.request("POST", "/v1/orders", zod_1.z.object({
            clOrdId: zod_1.z.string(), clientUid: zod_1.z.string(), symbol: zod_1.z.string(),
            status: zod_1.z.enum(["NEW", "PENDING_TRIGGER", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "REJECTED"]),
            rejectCode: zod_1.z.number().optional(),
        }).passthrough(), order, true);
        if (result.clOrdId !== order.clOrdId || result.clientUid !== order.clientUid || result.symbol !== order.symbol) {
            throw new app_error_1.AppError(502, "PERPETUALS_ORDER_UNCERTAIN", "Venue order correlation failed; reconcile before any retry");
        }
        if (result.status === "REJECTED")
            throw new app_error_1.AppError(409, "PERPETUALS_ENGINE_REJECTED", `Sandbox engine rejected order (code ${result.rejectCode ?? "unknown"})`);
        return result;
    }
    async clientPositions(clientUid) {
        if (this.simulated)
            return [];
        const rows = await this.request("GET", `/v1/positions/end-clients?clientUid=${encodeURIComponent(clientUid)}`, zod_1.z.array(zod_1.z.object({ clientUid: zod_1.z.string(), symbol: zod_1.z.string(), netQty: zod_1.z.string(), avgEntry: zod_1.z.string().optional() })).max(5000), undefined, true);
        if (rows.some((row) => row.clientUid !== clientUid))
            throw new app_error_1.AppError(502, "PERPETUALS_ATTRIBUTION_FAILED", "Venue returned positions for another client");
        return rows;
    }
    subscribe(symbol, emit, onError) {
        perpetuals_1.globalSymbol.parse(symbol);
        let stopped = false;
        let socket;
        let timer;
        let heartbeat;
        let attempts = 0;
        const publish = (channel, data) => emit({
            region: "GLOBAL", provider: "PERPETUALS", simulated: this.simulated, symbol, channel,
            receivedAt: new Date().toISOString(), data,
        });
        if (this.simulated || (0, demo_1.isDemoMode)()) {
            const tick = async () => {
                try {
                    const quote = await this.quote(symbol);
                    if (stopped)
                        return;
                    publish("quotes", { lastPrice: quote.price, bestBid: quote.price, bestAsk: quote.price });
                    publish("marks", { markPrice: quote.price, indexPrice: quote.price });
                    publish("trades", { price: quote.price, qty: "0.001", side: "BUY", ts: quote.at, simulated: true });
                    publish("orderbook", { type: "snapshot", bids: [[quote.price, "1"]], asks: [[quote.price, "1"]] });
                }
                catch {
                    onError(new app_error_1.AppError(503, "GLOBAL_FEED_ERROR", "Simulated feed failed"));
                }
            };
            void tick();
            heartbeat = setInterval(() => { void tick(); }, 1000);
            return () => { stopped = true; if (heartbeat)
                clearInterval(heartbeat); };
        }
        const connect = () => {
            if (stopped)
                return;
            let lastMessage = Date.now();
            let ready = false;
            let bookSeq;
            socket = this.socketFactory(this.base.replace("https:", "wss:") + "/ws/public");
            const ws = socket;
            ws.on("open", () => {
                ws.send(JSON.stringify({ op: "subscribe", reqId: "instanta-public", args: [
                        `ticker.${symbol}`, `markIndex.${symbol}`, `trades.${symbol}`, `orderbook.25.${symbol}`,
                    ] }));
            });
            ws.on("message", (buffer) => {
                lastMessage = Date.now();
                let raw;
                try {
                    raw = JSON.parse(buffer.toString());
                }
                catch {
                    onError(new app_error_1.AppError(502, "GLOBAL_FEED_INVALID", "Venue sent malformed feed JSON"));
                    ws.close();
                    return;
                }
                const control = zod_1.z.object({ success: zod_1.z.boolean().optional(), op: zod_1.z.string().optional() }).safeParse(raw);
                if (control.success && control.data.success === false) {
                    onError(new app_error_1.AppError(503, "GLOBAL_SUBSCRIPTION_REJECTED", "Venue refused the market subscription"));
                    ws.close();
                    return;
                }
                const frame = zod_1.z.object({
                    channel: zod_1.z.string(), type: zod_1.z.string().optional(), data: zod_1.z.unknown(),
                    seq: zod_1.z.number().int().safe().optional(), prevSeq: zod_1.z.number().int().safe().optional(),
                }).passthrough().safeParse(raw);
                if (!frame.success)
                    return; // Control acknowledgments/pongs are not market frames.
                const channel = frame.data.channel;
                if (!channel.endsWith(`.${symbol}`))
                    return;
                if (!ready) {
                    ready = true;
                    attempts = 0;
                    publish("status", { connected: true, reset: true });
                }
                if (channel.startsWith("orderbook.")) {
                    if (frame.data.type === "snapshot")
                        bookSeq = frame.data.seq;
                    else if (bookSeq === undefined || frame.data.prevSeq !== bookSeq) {
                        bookSeq = undefined;
                        publish("status", { stale: true, reason: "ORDERBOOK_GAP" });
                        ws.send(JSON.stringify({ op: "resync", reqId: "instanta-resync", args: [channel] }));
                        return;
                    }
                    else
                        bookSeq = frame.data.seq;
                    // Raw snapshots/deltas only. Consumers must validate CRC32C before constructing an executable book.
                    publish("orderbook", { ...frame.data, indicativeOnly: true });
                }
                else {
                    const topic = channel.startsWith("ticker.") ? "quotes" : channel.startsWith("markIndex.") ? "marks" : channel.startsWith("trades.") ? "trades" : null;
                    if (topic)
                        publish(topic, frame.data.data);
                }
            });
            ws.on("error", () => { onError(new app_error_1.AppError(503, "GLOBAL_FEED_DISCONNECTED", "Global market socket failed; retrying with backoff")); ws.terminate(); });
            ws.on("close", () => {
                if (heartbeat)
                    clearInterval(heartbeat);
                publish("status", { stale: true, reset: true });
                if (!stopped)
                    timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)));
            });
            heartbeat = setInterval(() => {
                if (Date.now() - lastMessage > 30_000)
                    ws.terminate();
                else if (ws.readyState === ws_1.default.OPEN)
                    ws.send(JSON.stringify({ op: "ping", reqId: "instanta-heartbeat" }));
            }, 10_000);
        };
        connect();
        return () => {
            stopped = true;
            if (timer)
                clearTimeout(timer);
            if (heartbeat)
                clearInterval(heartbeat);
            socket?.terminate();
        };
    }
}
exports.PerpetualsAdapter = PerpetualsAdapter;
let adapter;
function perpetualsAdapter() {
    if (!adapter) {
        const environment = zod_1.z.enum(["development", "staging", "test", "production"]).parse(process.env.NODE_ENV ?? "development");
        const venue = zod_1.z.enum(["sandbox", "production"]).parse(process.env.PERPETUALS_ENVIRONMENT ?? "sandbox");
        adapter = new PerpetualsAdapter({
            environment, venue, key: process.env.PERPETUALS_API_KEY, secret: process.env.PERPETUALS_API_SECRET,
        });
    }
    return adapter;
}
