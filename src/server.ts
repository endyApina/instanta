import "dotenv/config";
import { app } from "./app";
import { prisma } from "./config/prisma";
import { validateRuntime, isProduction } from "./config/runtime";
import { partners } from "./adapters";
import { perpetualsAdapter } from "./adapters/perpetuals.adapter";
import { attachUnifiedMarketStream } from "./services/marketData.service";
import { isDemoMode } from "./config/demo";
import { assertDemoDatabase } from "./services/demoMode.service";
import { attachLocalDemoStream } from "./services/local-demo-proxy";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

async function main() {
  validateRuntime();
  partners();
  perpetualsAdapter();
  await prisma.$connect();
  if (isDemoMode()) await assertDemoDatabase();
  if (await prisma.user.count({ where: { OR: [{ phoneNumber: { not: null } }, { emailLookupHash: null }] } })) {
    throw new Error("Legacy plaintext profiles remain. Run npm run pii:migrate before starting the API.");
  }
  if (isProduction() && await prisma.wallet.count({ where: { virtualAccountNumber: { startsWith: "MOCK-" } } })) {
    throw new Error("Simulated bank accounts exist in this database. Use a separate certified production database.");
  }
  const server = app.listen(port, process.env.HOST ?? "0.0.0.0", () => {
    console.info(`Instanta API listening on port ${port}`);
  });
  const stopStreams = attachUnifiedMarketStream(server);
  attachLocalDemoStream(server);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopStreams();
    const timeout = setTimeout(() => {
      console.error("[ALERT] Graceful shutdown timed out");
      process.exit(1);
    }, 20_000);
    timeout.unref();
    server.close(() => {
      void prisma.$disconnect().then(() => clearTimeout(timeout)).catch(() => { process.exitCode = 1; });
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
void main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : "API startup failed");
  await prisma.$disconnect();
  process.exitCode = 1;
});
