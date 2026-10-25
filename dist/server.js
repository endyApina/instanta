"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = require("./app");
const prisma_1 = require("./config/prisma");
const runtime_1 = require("./config/runtime");
const adapters_1 = require("./adapters");
const perpetuals_adapter_1 = require("./adapters/perpetuals.adapter");
const marketData_service_1 = require("./services/marketData.service");
const demo_1 = require("./config/demo");
const demoMode_service_1 = require("./services/demoMode.service");
const local_demo_proxy_1 = require("./services/local-demo-proxy");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port");
}
async function main() {
    (0, runtime_1.validateRuntime)();
    (0, adapters_1.partners)();
    (0, perpetuals_adapter_1.perpetualsAdapter)();
    await prisma_1.prisma.$connect();
    if ((0, demo_1.isDemoMode)())
        await (0, demoMode_service_1.assertDemoDatabase)();
    if (await prisma_1.prisma.user.count({ where: { OR: [{ phoneNumber: { not: null } }, { emailLookupHash: null }] } })) {
        throw new Error("Legacy plaintext profiles remain. Run npm run pii:migrate before starting the API.");
    }
    if ((0, runtime_1.isProduction)() && await prisma_1.prisma.wallet.count({ where: { virtualAccountNumber: { startsWith: "MOCK-" } } })) {
        throw new Error("Simulated bank accounts exist in this database. Use a separate certified production database.");
    }
    const server = app_1.app.listen(port, process.env.HOST ?? "0.0.0.0", () => {
        console.info(`Instanta API listening on port ${port}`);
    });
    const stopStreams = (0, marketData_service_1.attachUnifiedMarketStream)(server);
    (0, local_demo_proxy_1.attachLocalDemoStream)(server);
    let stopping = false;
    const shutdown = () => {
        if (stopping)
            return;
        stopping = true;
        stopStreams();
        const timeout = setTimeout(() => {
            console.error("[ALERT] Graceful shutdown timed out");
            process.exit(1);
        }, 20_000);
        timeout.unref();
        server.close(() => {
            void prisma_1.prisma.$disconnect().then(() => clearTimeout(timeout)).catch(() => { process.exitCode = 1; });
        });
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}
void main().catch(async (error) => {
    console.error(error instanceof Error ? error.message : "API startup failed");
    await prisma_1.prisma.$disconnect();
    process.exitCode = 1;
});
