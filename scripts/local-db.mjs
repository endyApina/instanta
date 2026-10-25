import "dotenv/config";
import { spawnSync } from "node:child_process";

function validateLocalDatabase() {
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) throw new Error("Set POSTGRES_PASSWORD and a matching DATABASE_URL in .env. See .env.example.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("Set DATABASE_URL in .env. See .env.example.");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  const user = process.env.POSTGRES_USER || "instanta";
  const database = process.env.POSTGRES_DB || "instanta";
  const port = process.env.POSTGRES_PORT || "5432";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("POSTGRES_PORT must be a valid TCP port.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1"].includes(url.hostname)
    || (url.port || "5432") !== port
    || decodeURIComponent(url.username) !== user
    || decodeURIComponent(url.password) !== password
    || decodeURIComponent(url.pathname.slice(1)) !== database
    || (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public")
    || ["host", "hostaddr", "port", "dbname", "user", "password"].some((key) => url.searchParams.has(key))) {
    throw new Error("Local startup requires DATABASE_URL to match POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB and POSTGRES_PORT on localhost (public schema). For an external database, use dev:services instead.");
  }
}

function run(script) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw new Error(`Could not run ${script}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${script} failed. Check the output above; the application was not started.`);
}

try {
  validateLocalDatabase();
  if (!process.argv.includes("--check")) {
    run("db:up");
    run("db:generate");
    run("db:deploy");
  }
} catch (error) {
  console.error(`Local database setup: ${error instanceof Error ? error.message : "Unknown failure"}`);
  process.exitCode = 1;
}
