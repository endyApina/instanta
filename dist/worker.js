"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prisma_1 = require("./config/prisma");
const runtime_1 = require("./config/runtime");
const adapters_1 = require("./adapters");
const jobs_service_1 = require("./services/jobs.service");
const demo_1 = require("./config/demo");
const demoMode_service_1 = require("./services/demoMode.service");
async function main() {
    (0, runtime_1.validateRuntime)();
    if ((0, demo_1.isDemoMode)())
        await (0, demoMode_service_1.assertDemoDatabase)();
    (0, adapters_1.partners)();
    let running = true;
    process.on("SIGTERM", () => { running = false; });
    process.on("SIGINT", () => { running = false; });
    let lastCleanup = 0;
    try {
        while (running) {
            try {
                if (Date.now() - lastCleanup > 60_000) {
                    await (0, jobs_service_1.cleanupExpiredSecurityRecords)();
                    lastCleanup = Date.now();
                }
                if (!(await (0, jobs_service_1.processNextJob)()))
                    await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            catch {
                console.error("[ALERT] Worker iteration failed; retrying in 5 seconds. Check database health.");
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }
    finally {
        await prisma_1.prisma.$disconnect();
    }
}
void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Worker startup failed");
    process.exitCode = 1;
});
