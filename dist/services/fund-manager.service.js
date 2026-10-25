"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.simulateFundBatch = simulateFundBatch;
const adapters_1 = require("../adapters");
const prisma_1 = require("../config/prisma");
const app_error_1 = require("../errors/app-error");
const transaction_service_1 = require("./transaction.service");
const money_1 = require("../domain/money");
async function simulateFundBatch(batchId, orders) {
    if (process.env.NODE_ENV === "production" || process.env.FUND_API_KEY) {
        throw new app_error_1.AppError(503, "LIVE_TRADING_DISABLED", "Live order routing requires a certified settlement/reservation workflow");
    }
    if (!orders.length || orders.length > 100 || new Set(orders.map((order) => order.id)).size !== orders.length) {
        throw new app_error_1.AppError(400, "INVALID_BATCH", "Supply 1-100 uniquely identified paper orders");
    }
    for (const order of orders)
        (0, money_1.moneyAmount)(order.amount);
    const executions = await (0, adapters_1.partners)().fund.placeBatch(batchId, orders);
    await (0, transaction_service_1.serializable)(async (tx) => {
        await (0, transaction_service_1.assertWritable)(tx);
        for (const execution of executions) {
            const previous = await tx.partnerExecution.findUnique({ where: { id: execution.id } });
            if (previous && !previous.amount.eq(execution.amount))
                throw new app_error_1.AppError(409, "ORDER_CONFLICT", "Paper order ID reused with different amounts");
            await tx.partnerExecution.upsert({
                where: { id: execution.id }, update: {},
                create: { ...execution, provider: "MOCK_FUND", simulated: true },
            });
        }
    });
    return prisma_1.prisma.partnerExecution.findMany({ where: { id: { in: orders.map((order) => order.id) } } });
}
