import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function check(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ["scripts/local-db.mjs", "--check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: "/nonexistent/instanta-test-env",
      POSTGRES_USER: "instanta",
      POSTGRES_PASSWORD: "test-password",
      POSTGRES_DB: "instanta",
      POSTGRES_PORT: "5432",
      DATABASE_URL: "postgresql://instanta:test-password@127.0.0.1:5432/instanta?schema=public",
      ...overrides,
    },
  });
}

test("local startup accepts matching credentials, custom port and encoded passwords", () => {
  assert.equal(check({}).status, 0);
  assert.equal(check({
    POSTGRES_PASSWORD: "test@password",
    POSTGRES_PORT: "55432",
    DATABASE_URL: "postgresql://instanta:test%40password@localhost:55432/instanta?schema=public",
  }).status, 0);
});

test("local startup rejects missing credentials and mismatched or external targets", () => {
  for (const overrides of [
    { POSTGRES_PASSWORD: "" },
    { DATABASE_URL: "" },
    { DATABASE_URL: "not-a-url" },
    { POSTGRES_PORT: "5433" },
    { POSTGRES_PORT: "invalid" },
    { DATABASE_URL: "postgresql://instanta:test-password@external.example:5432/instanta" },
    { DATABASE_URL: "postgresql://instanta:test-password@localhost:5432/instanta?host=external.example" },
  ]) {
    const result = check(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Local database setup:/);
    assert.ok(!result.stderr.includes("test-password"));
  }
});
