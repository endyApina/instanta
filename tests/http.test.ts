import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";

test("dashboard requires bearer authentication and invalid registration uses the error wrapper", async () => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/instanta_test";
  const { app } = await import("../src/app");
  const { prisma } = await import("../src/config/prisma");
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const dashboard = await fetch(`${base}/api/v1/dashboard`);
    assert.equal(dashboard.status, 401);
    assert.deepEqual(await dashboard.json(), {
      success: false, error: { code: "UNAUTHORIZED", message: "Please sign in to continue." },
    });
    const market = await fetch(`${base}/api/v1/markets/instruments?provider=NGX`);
    assert.equal(market.status, 401);
    const register = await fetch(`${base}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(register.status, 400);
    assert.equal((await register.json()).error.code, "INVALID_REQUEST");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
});
