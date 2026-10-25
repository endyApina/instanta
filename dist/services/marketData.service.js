"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachUnifiedMarketStream = attachUnifiedMarketStream;
const ws_1 = require("ws");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const perpetuals_adapter_1 = require("../adapters/perpetuals.adapter");
const perpetuals_1 = require("../domain/perpetuals");
const market_data_1 = require("../domain/market-data");
const market_data_service_1 = require("./market-data.service");
const app_error_1 = require("../errors/app-error");
const session_service_1 = require("./session.service");
const demo_1 = require("../config/demo");
const subscribeSchema = zod_1.z.discriminatedUnion("region", [
    zod_1.z.object({ op: zod_1.z.literal("subscribe"), region: zod_1.z.literal("GLOBAL"), symbol: perpetuals_1.globalSymbol }),
    zod_1.z.object({ op: zod_1.z.literal("subscribe"), region: zod_1.z.literal("LOCAL"),
        provider: market_data_1.marketProviderSchema, symbol: market_data_1.marketSymbolSchema, range: market_data_1.marketRangeSchema }),
]);
const authSchema = zod_1.z.object({ op: zod_1.z.literal("auth"), token: zod_1.z.string().min(1).max(4096), deviceId: zod_1.z.string().min(20).max(128) });
/** One authenticated transport; local EOD snapshots retain their frequency and are never called ticks. */
function attachUnifiedMarketStream(server) {
    const wss = new ws_1.WebSocketServer({ noServer: true, maxPayload: 16_384 });
    const paths = new Set(["/api/v1/markets/stream", "/api/v1/perpetuals/quotes", "/api/v1/perpetuals/marks", "/api/v1/perpetuals/trades"]);
    server.on("upgrade", (request, socket, head) => {
        if ((0, demo_1.isDemoMode)() && request.url?.startsWith("/demo-api/"))
            request.url = request.url.replace(/^\/demo-api/, "/api");
        if (request.url?.startsWith("/demo-api/"))
            return;
        const url = new URL(request.url ?? "/", "http://localhost");
        const origin = request.headers.origin;
        if (!paths.has(url.pathname) || url.search || wss.clients.size >= 100
            || (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`)) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => { wss.emit("connection", ws, request); });
    });
    wss.on("connection", (ws, request) => {
        let stop;
        let auth;
        let userId;
        let busy = false;
        let generation = 0;
        let alive = true;
        const ip = request.socket.remoteAddress ?? "unknown";
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const filter = path.endsWith("/quotes") ? "quotes" : path.endsWith("/marks") ? "marks" : path.endsWith("/trades") ? "trades" : null;
        const send = (message) => {
            if (ws.readyState !== ws_1.WebSocket.OPEN)
                return;
            if (ws.bufferedAmount > 262_144) {
                ws.close(1013, "Slow consumer; reconnect for a fresh snapshot");
                return;
            }
            ws.send(JSON.stringify(message));
        };
        const error = (failure) => send({ type: "error",
            code: failure instanceof app_error_1.AppError ? failure.code : "GLOBAL_STREAM_ERROR",
            message: failure instanceof app_error_1.AppError ? failure.message : "Market stream failed; retry after checking configuration",
        });
        const timeout = setTimeout(() => { if (!auth)
            ws.close(1008, "Authenticate within five seconds"); }, 5000);
        const heartbeat = setInterval(() => {
            if (!alive) {
                ws.terminate();
                return;
            }
            alive = false;
            ws.ping();
            if (auth)
                void (0, auth_1.authenticateSession)(auth.token, auth.deviceId, ip).catch((failure) => {
                    error(failure);
                    ws.close(1008, "Session validation failed");
                });
        }, 20_000);
        ws.on("pong", () => { alive = true; });
        ws.on("message", (buffer) => {
            if (busy) {
                error(new app_error_1.AppError(429, "STREAM_BUSY", "Wait for the current subscription acknowledgment"));
                return;
            }
            busy = true;
            void (async () => {
                const payload = JSON.parse(buffer.toString());
                if (!auth) {
                    const parsed = authSchema.parse(payload);
                    const session = await (0, auth_1.authenticateSession)(parsed.token, parsed.deviceId, ip);
                    if (ws.readyState !== ws_1.WebSocket.OPEN)
                        return;
                    userId = session.userId;
                    auth = parsed;
                    clearTimeout(timeout);
                    send({ type: "authenticated" });
                    return;
                }
                const subscription = subscribeSchema.parse(payload);
                await (0, auth_1.authenticateSession)(auth.token, auth.deviceId, ip);
                await (0, session_service_1.enforceRateLimit)(`market-stream:${userId}`, 30, 60, "Too many stream subscriptions");
                if (ws.readyState !== ws_1.WebSocket.OPEN)
                    return;
                stop?.();
                stop = undefined;
                const current = ++generation;
                if (subscription.region === "GLOBAL") {
                    const adapter = (0, perpetuals_adapter_1.perpetualsAdapter)();
                    if (!(await adapter.symbols()).some((item) => item.symbol === subscription.symbol))
                        throw new app_error_1.AppError(404, "GLOBAL_SYMBOL_NOT_FOUND", "Unknown global symbol");
                    if (ws.readyState !== ws_1.WebSocket.OPEN)
                        return;
                    const emit = (event) => {
                        if (current === generation && (!filter || event.channel === filter || event.channel === "status"))
                            send({ type: "market", event });
                    };
                    stop = adapter.subscribe(subscription.symbol, emit, error);
                }
                else {
                    if (filter)
                        throw new app_error_1.AppError(400, "GLOBAL_CHANNEL_ONLY", "Local subscriptions use the unified stream path");
                    let active = true;
                    let polling = false;
                    const tick = async () => {
                        if (polling || !active)
                            return;
                        polling = true;
                        try {
                            const history = await market_data_service_1.marketData.history(subscription.provider, subscription.symbol, subscription.range);
                            if (active && current === generation)
                                send({ type: "market", event: {
                                        region: "LOCAL", provider: subscription.provider, symbol: subscription.symbol,
                                        simulated: process.env.IS_DEMO_MODE === "true", channel: "history", receivedAt: new Date().toISOString(), data: history,
                                    } });
                        }
                        catch (failure) {
                            if (active)
                                error(failure);
                        }
                        finally {
                            polling = false;
                        }
                    };
                    void tick();
                    const timer = setInterval(() => { void tick(); }, 60_000);
                    stop = () => { active = false; clearInterval(timer); };
                }
                send({ type: "subscribed", region: subscription.region, symbol: subscription.symbol });
            })().catch((failure) => {
                error(failure);
                if (!auth)
                    ws.close(1008, "Authentication failed");
            }).finally(() => { busy = false; });
        });
        ws.on("error", () => { console.warn("[WARN] Market stream socket failed"); ws.terminate(); });
        ws.on("close", () => {
            generation++;
            stop?.();
            clearTimeout(timeout);
            clearInterval(heartbeat);
        });
    });
    return () => {
        for (const client of wss.clients)
            client.terminate();
        wss.close();
    };
}
