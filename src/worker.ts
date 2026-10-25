import "dotenv/config";
import { prisma } from "./config/prisma";
import { validateRuntime } from "./config/runtime";
import { partners } from "./adapters";
import { cleanupExpiredSecurityRecords, processNextJob } from "./services/jobs.service";
import { isDemoMode } from "./config/demo";
import { assertDemoDatabase } from "./services/demoMode.service";

async function main() {
  validateRuntime();
  if (isDemoMode()) await assertDemoDatabase();
  partners();
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });
  let lastCleanup = 0;
  try {
    while (running) {
      try {
        if (Date.now() - lastCleanup > 60_000) {
          await cleanupExpiredSecurityRecords();
          lastCleanup = Date.now();
        }
        if (!(await processNextJob())) await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch {
        console.error("[ALERT] Worker iteration failed; retrying in 5 seconds. Check database health.");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  } finally { await prisma.$disconnect(); }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Worker startup failed");
  process.exitCode = 1;
});
