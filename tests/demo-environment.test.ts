import assert from "node:assert/strict";
import test from "node:test";

test("automatic demo has stable independent credentials and never mutates the normal environment", async () => {
  // @ts-expect-error Startup helpers are native ESM, executed by Node without compilation.
  const { createDemoEnvironment } = await import("../scripts/demo-environment.mjs");
  const source = { NODE_ENV: "development", JWT_SECRET: "a".repeat(40), DATABASE_URL: "postgresql://normal:normal@localhost/normal", PORT: "3000" };
  const copy = { ...source };
  const demo = createDemoEnvironment(source, 5555);
  assert.deepEqual(source, copy);
  assert.equal(demo.IS_DEMO_MODE, "true");
  assert.equal(demo.HOST, "127.0.0.1");
  assert.equal(new URL(demo.DATABASE_URL).pathname, "/instanta_demo");
  assert.equal(new URL(demo.DATABASE_URL).port, "5555");
  assert.notEqual(demo.JWT_SECRET, source.JWT_SECRET);
  assert.equal(new Set([demo.JWT_SECRET, demo.PII_ENCRYPTION_KEY, demo.BAAS_WEBHOOK_SECRET, demo.KYC_WEBHOOK_SECRET, demo.POSTGRES_PASSWORD]).size, 5);
  assert.equal(createDemoEnvironment(source, 5556).POSTGRES_PASSWORD, demo.POSTGRES_PASSWORD);
  assert.throws(() => createDemoEnvironment({ ...source, NODE_ENV: "production" }, 5555), /production/);
  assert.throws(() => createDemoEnvironment({ ...source, LOCAL_DEMO_PORT: "3000" }, 5555), /different from PORT/);
});
