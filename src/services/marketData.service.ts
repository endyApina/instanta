import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { authenticateSession } from "../middleware/auth";
import { perpetualsAdapter } from "../adapters/perpetuals.adapter";
import { globalSymbol, type GlobalMarketEvent } from "../domain/perpetuals";
import { marketProviderSchema, marketRangeSchema, marketSymbolSchema } from "../domain/market-data";
import { marketData } from "./market-data.service";
import { AppError } from "../errors/app-error";
import { enforceRateLimit } from "./session.service";
import { isDemoMode } from "../config/demo";

const subscribeSchema = z.discriminatedUnion("region", [
  z.object({ op: z.literal("subscribe"), region: z.literal("GLOBAL"), symbol: globalSymbol }),
  z.object({ op: z.literal("subscribe"), region: z.literal("LOCAL"),
    provider: marketProviderSchema, symbol: marketSymbolSchema, range: marketRangeSchema }),
]);
const authSchema = z.object({ op: z.literal("auth"), token: z.string().min(1).max(4096), deviceId: z.string().min(20).max(128) });

/** One authenticated transport; local EOD snapshots retain their frequency and are never called ticks. */
export function attachUnifiedMarketStream(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
  const paths = new Set(["/api/v1/markets/stream", "/api/v1/perpetuals/quotes", "/api/v1/perpetuals/marks", "/api/v1/perpetuals/trades"]);
  server.on("upgrade", (request, socket, head) => {
    if (isDemoMode() && request.url?.startsWith("/demo-api/")) request.url = request.url.replace(/^\/demo-api/, "/api");
    if (request.url?.startsWith("/demo-api/")) return;
    const url = new URL(request.url ?? "/", "http://localhost");
    const origin = request.headers.origin;
    if (!paths.has(url.pathname) || url.search || wss.clients.size >= 100
      || (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => { wss.emit("connection", ws, request); });
  });
  wss.on("connection", (ws, request) => {
    let stop: (() => void) | undefined;
    let auth: z.infer<typeof authSchema> | undefined;
    let userId: string | undefined;
    let busy = false;
    let generation = 0;
    let alive = true;
    const ip = request.socket.remoteAddress ?? "unknown";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const filter = path.endsWith("/quotes") ? "quotes" : path.endsWith("/marks") ? "marks" : path.endsWith("/trades") ? "trades" : null;
    const send = (message: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 262_144) { ws.close(1013, "Slow consumer; reconnect for a fresh snapshot"); return; }
      ws.send(JSON.stringify(message));
    };
    const error = (failure: unknown) => send({ type: "error",
      code: failure instanceof AppError ? failure.code : "GLOBAL_STREAM_ERROR",
      message: failure instanceof AppError ? failure.message : "Market stream failed; retry after checking configuration",
    });
    const timeout = setTimeout(() => { if (!auth) ws.close(1008, "Authenticate within five seconds"); }, 5000);
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
      if (auth) void authenticateSession(auth.token, auth.deviceId, ip).catch((failure: unknown) => {
        error(failure);
        ws.close(1008, "Session validation failed");
      });
    }, 20_000);
    ws.on("pong", () => { alive = true; });
    ws.on("message", (buffer) => {
      if (busy) { error(new AppError(429, "STREAM_BUSY", "Wait for the current subscription acknowledgment")); return; }
      busy = true;
      void (async () => {
        const payload: unknown = JSON.parse(buffer.toString());
        if (!auth) {
          const parsed = authSchema.parse(payload);
          const session = await authenticateSession(parsed.token, parsed.deviceId, ip);
          if (ws.readyState !== WebSocket.OPEN) return;
          userId = session.userId;
          auth = parsed;
          clearTimeout(timeout);
          send({ type: "authenticated" });
          return;
        }
        const subscription = subscribeSchema.parse(payload);
        await authenticateSession(auth.token, auth.deviceId, ip);
        await enforceRateLimit(`market-stream:${userId!}`, 30, 60, "Too many stream subscriptions");
        if (ws.readyState !== WebSocket.OPEN) return;
        stop?.();
        stop = undefined;
        const current = ++generation;
        if (subscription.region === "GLOBAL") {
          const adapter = perpetualsAdapter();
          if (!(await adapter.symbols()).some((item) => item.symbol === subscription.symbol)) throw new AppError(404, "GLOBAL_SYMBOL_NOT_FOUND", "Unknown global symbol");
          if (ws.readyState !== WebSocket.OPEN) return;
          const emit = (event: GlobalMarketEvent) => {
            if (current === generation && (!filter || event.channel === filter || event.channel === "status")) send({ type: "market", event });
          };
          stop = adapter.subscribe(subscription.symbol, emit, error);
        } else {
          if (filter) throw new AppError(400, "GLOBAL_CHANNEL_ONLY", "Local subscriptions use the unified stream path");
          let active = true;
          let polling = false;
          const tick = async () => {
            if (polling || !active) return;
            polling = true;
            try {
              const history = await marketData.history(subscription.provider, subscription.symbol, subscription.range);
              if (active && current === generation) send({ type: "market", event: {
                region: "LOCAL", provider: subscription.provider, symbol: subscription.symbol,
                simulated: process.env.IS_DEMO_MODE === "true", channel: "history", receivedAt: new Date().toISOString(), data: history,
              } });
            } catch (failure) { if (active) error(failure); }
            finally { polling = false; }
          };
          void tick();
          const timer = setInterval(() => { void tick(); }, 60_000);
          stop = () => { active = false; clearInterval(timer); };
        }
        send({ type: "subscribed", region: subscription.region, symbol: subscription.symbol });
      })().catch((failure: unknown) => {
        error(failure);
        if (!auth) ws.close(1008, "Authentication failed");
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
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
