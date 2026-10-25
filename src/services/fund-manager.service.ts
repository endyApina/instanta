import { partners, type FundOrder } from "../adapters";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";
import { assertWritable, serializable } from "./transaction.service";
import { moneyAmount } from "../domain/money";

export async function simulateFundBatch(batchId: string, orders: FundOrder[]) {
  if (process.env.NODE_ENV === "production" || process.env.FUND_API_KEY) {
    throw new AppError(503, "LIVE_TRADING_DISABLED", "Live order routing requires a certified settlement/reservation workflow");
  }
  if (!orders.length || orders.length > 100 || new Set(orders.map((order) => order.id)).size !== orders.length) {
    throw new AppError(400, "INVALID_BATCH", "Supply 1-100 uniquely identified paper orders");
  }
  for (const order of orders) moneyAmount(order.amount);
  const executions = await partners().fund.placeBatch(batchId, orders);
  await serializable(async (tx) => {
    await assertWritable(tx);
    for (const execution of executions) {
      const previous = await tx.partnerExecution.findUnique({ where: { id: execution.id } });
      if (previous && !previous.amount.eq(execution.amount)) throw new AppError(409, "ORDER_CONFLICT", "Paper order ID reused with different amounts");
      await tx.partnerExecution.upsert({
        where: { id: execution.id }, update: {},
        create: { ...execution, provider: "MOCK_FUND", simulated: true },
      });
    }
  });
  return prisma.partnerExecution.findMany({ where: { id: { in: orders.map((order) => order.id) } } });
}
