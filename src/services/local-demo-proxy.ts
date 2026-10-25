import { request as upstreamRequest, type Server } from "node:http";
import type { RequestHandler } from "express";
import { isDemoMode } from "../config/demo";

export function localDemoEnabled(): boolean {
  return process.env.ENABLE_LOCAL_DEMO === "true" && process.env.NODE_ENV !== "production" && !isDemoMode();
}
function demoPort(): number {
  const port = Number(process.env.LOCAL_DEMO_PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LOCAL_DEMO_PORT must be a valid TCP port.");
  return port;
}
export const proxyLocalDemo: RequestHandler = (request, response) => {
  if (!localDemoEnabled()) {
    response.status(503).json({ success: false, error: {
      code: "LOCAL_DEMO_UNAVAILABLE", message: "The local demo is not running. Restart the app with npm start or npm run dev to start it safely.",
    } });
    return;
  }
  const upstream = upstreamRequest({
    host: "127.0.0.1", port: demoPort(), method: request.method,
    path: request.originalUrl.replace(/^\/demo-api/, "/api"),
    headers: request.headers,
  }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.on("error", () => response.destroy());
    incoming.pipe(response);
  });
  upstream.setTimeout(20_000, () => upstream.destroy(new Error("Local demo request timed out")));
  upstream.on("error", () => {
    console.error("[WARN] Local demo API is unavailable.");
    if (response.headersSent) { response.destroy(); return; }
    response.status(503).json({ success: false, error: {
      code: "LOCAL_DEMO_UNAVAILABLE", message: "The demo could not be reached. Restart the app and try again. Your normal account is unchanged.",
    } });
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
};

export function attachLocalDemoStream(server: Server) {
  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/demo-api/")) return;
    if (!localDemoEnabled()) { socket.destroy(); return; }
    const upstream = upstreamRequest({
      host: "127.0.0.1", port: demoPort(), path: request.url.replace(/^\/demo-api/, "/api"),
      headers: request.headers,
    });
    upstream.setTimeout(10_000, () => upstream.destroy(new Error("Local demo stream timed out")));
    upstream.on("upgrade", (incoming, remote, remoteHead) => {
      upstream.setTimeout(0);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.on("response", (incoming) => { incoming.resume(); socket.destroy(); });
    upstream.on("error", () => { console.warn("[WARN] Local demo market stream is unavailable."); socket.destroy(); });
    socket.on("close", () => upstream.destroy());
    upstream.end();
  });
}
