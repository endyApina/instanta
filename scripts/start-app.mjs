import "dotenv/config";
import { spawn } from "node:child_process";
import net from "node:net";
import { createDemoEnvironment } from "./demo-environment.mjs";

const development = process.argv.includes("--dev");
const demoOnly = process.argv.includes("--demo-only");
const children = new Set();
let stopping = false;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function launch(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  children.add(child);
  child.on("error", (error) => { console.error(`App process could not start: ${error.message}`); shutdown(1); });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`App process stopped unexpectedly (${signal ?? code}).`);
      shutdown(code || 1);
    }
  });
  return child;
}
async function runNpm(script, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { env, stdio: "inherit" });
    children.add(child);
    child.on("error", reject);
    child.on("exit", (code) => {
      children.delete(child);
      if (code === 0 && !stopping) resolve();
      else reject(new Error(`${script} did not complete. The app was not started.`));
    });
  });
}
async function availablePort(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local database port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function waitForDemo(port) {
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/demo/config`, { signal: AbortSignal.timeout(1000) });
      const payload = await response.json();
      if (response.ok && payload.success === true && payload.data?.enabled === true) return;
    } catch (error) {
      if (attempt === 59) throw new Error("The isolated demo did not become ready. Check the demo API logs.", { cause: error });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The isolated demo did not become ready.");
}
async function main() {
  const automaticDemo = process.env.NODE_ENV !== "production" && process.env.IS_DEMO_MODE !== "true";
  const primary = { ...process.env, ENABLE_LOCAL_DEMO: automaticDemo ? "true" : "false" };
  const serverArgs = development ? ["--import", "tsx", "src/server.ts"] : ["dist/server.js"];
  const workerArgs = development ? ["--import", "tsx", "src/worker.ts"] : ["dist/worker.js"];
  if (automaticDemo || demoOnly) {
    const demo = createDemoEnvironment(process.env, await availablePort());
    await availablePort(Number(demo.PORT));
    console.info("[DEMO] Preparing a separate local database and virtual-funds API. Normal account data is unchanged.");
    await runNpm("db:up", demo);
    await runNpm("db:deploy", demo);
    launch(serverArgs, demo);
    launch(workerArgs, demo);
    await waitForDemo(demo.PORT);
    console.info(`[DEMO] Ready on loopback port ${demo.PORT}.`);
    if (demoOnly) return;
  }
  launch(serverArgs, primary);
  if (development) {
    launch(workerArgs, primary);
    launch(["node_modules/vite/bin/vite.js", "--config", "web/vite.config.mts"], primary);
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "App startup failed.");
  shutdown(1);
});
