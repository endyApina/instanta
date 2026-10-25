import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { proxyLocalDemo, attachLocalDemoStream } from "../src/services/local-demo-proxy";

test("local demo proxy isolates requests, forwards streams and reports startup failures", async () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, IS_DEMO_MODE: process.env.IS_DEMO_MODE,
    ENABLE_LOCAL_DEMO: process.env.ENABLE_LOCAL_DEMO, LOCAL_DEMO_PORT: process.env.LOCAL_DEMO_PORT };
  process.env.NODE_ENV = "development"; process.env.IS_DEMO_MODE = "false"; process.env.ENABLE_LOCAL_DEMO = "true";
  const remote = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, body, device: request.headers["x-device-id"] }));
    });
  });
  const wss = new WebSocketServer({ server: remote });
  wss.on("connection", (socket, request) => socket.on("message", (data) => socket.send(JSON.stringify({ path: request.url, message: data.toString() }))));
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const remoteAddress = remote.address(); assert.ok(remoteAddress && typeof remoteAddress !== "string");
  process.env.LOCAL_DEMO_PORT = String(remoteAddress.port);
  const app = express();
  app.use("/demo-api/v1", proxyLocalDemo);
  const server = app.listen(0, "127.0.0.1");
  attachLocalDemoStream(server);
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const result = await fetch(`${base}/demo-api/v1/savings/goals?test=1`, {
      method: "POST", headers: { "content-type": "application/json", "x-device-id": "persistent-device-id" }, body: '{"initialAmount":"100"}',
    });
    assert.deepEqual(await result.json(), { path: "/api/v1/savings/goals?test=1", body: '{"initialAmount":"100"}', device: "persistent-device-id" });
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/demo-api/v1/markets/stream`);
    try {
      await once(socket, "open");
      const reply = once(socket, "message");
      socket.send("test-stream");
      assert.deepEqual(JSON.parse(String((await reply)[0])), { path: "/api/v1/markets/stream", message: "test-stream" });
    } finally { socket.terminate(); }
    process.env.NODE_ENV = "production";
    assert.equal((await fetch(`${base}/demo-api/v1/demo/config`)).status, 503);
    process.env.NODE_ENV = "development"; process.env.ENABLE_LOCAL_DEMO = "false";
    assert.equal((await fetch(`${base}/demo-api/v1/demo/config`)).status, 503);
  } finally {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => remote.close(() => resolve())),
    ]);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
