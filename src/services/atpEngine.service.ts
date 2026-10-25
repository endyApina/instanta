import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { calculateFloorProtection, evaluateDrift } from "../domain/atp";
import type { Allocation, Portfolio, RebalanceSignal } from "../types";
import { assertWritable } from "./transaction.service";
export { calculateFloorProtection, evaluateDrift } from "../domain/atp";

interface PersistEvaluationInput {
  userId: string;
  principal: number;
  maxLossPercent: number;
  riskFreeRate: number;
  timeHorizonYears: number;
  portfolio: Portfolio;
  targetAllocation: Allocation;
}

export async function evaluateAndPersist(input: PersistEvaluationInput, tx: Prisma.TransactionClient = prisma): Promise<{
  evaluationId: string;
  requiredTbills: number;
  floorValue: number;
  signal: RebalanceSignal;
}> {
  await assertWritable(tx);
  const floor = calculateFloorProtection(
    input.principal,
    input.maxLossPercent,
    input.riskFreeRate,
    input.timeHorizonYears,
  );
  const signal = evaluateDrift(input.portfolio, input.targetAllocation);
  const actualByClass = new Map<string, number>();
  for (const holding of input.portfolio.holdings) {
    actualByClass.set(holding.assetClass, (actualByClass.get(holding.assetClass) ?? 0) + holding.marketValue);
  }
  const assetClasses = new Set([...Object.keys(input.targetAllocation), ...actualByClass.keys()]);
  const evaluation = await tx.portfolioEvaluation.create({
    data: {
      userId: input.userId,
      principal: new Prisma.Decimal(input.principal.toFixed(2)),
      maxLossPercent: new Prisma.Decimal(input.maxLossPercent.toFixed(4)),
      riskFreeRate: new Prisma.Decimal(input.riskFreeRate.toFixed(6)),
      timeHorizonYears: new Prisma.Decimal(input.timeHorizonYears.toFixed(4)),
      requiredTbills: new Prisma.Decimal(floor.requiredTbills.toFixed(2)),
      floorValue: new Prisma.Decimal(floor.floorValue.toFixed(2)),
      shouldRebalance: signal.shouldRebalance,
      allocations: {
        create: [...assetClasses].map((assetClass) => {
          const drift = signal.targetVsActual[assetClass]!;
          return {
            assetClass,
            targetPercentage: new Prisma.Decimal((drift.target / 100).toFixed(6)),
            actualPercentage: new Prisma.Decimal((drift.actual / 100).toFixed(6)),
            driftPercentagePoints: new Prisma.Decimal(drift.drift.toFixed(6)),
            floorValue: assetClass.toLowerCase().includes("t-bill")
              ? new Prisma.Decimal(floor.requiredTbills.toFixed(2))
              : undefined,
          };
        }),
      },
    },
    select: { id: true },
  });
  return { evaluationId: evaluation.id, ...floor, signal };
}
