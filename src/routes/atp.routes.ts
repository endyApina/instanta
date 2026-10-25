import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { evaluateAndPersist } from "../services/atpEngine.service";
import { idempotentMutation } from "../middleware/idempotency.middleware";

export const atpRoutes = Router();

const evaluationSchema = z.object({
  principal: z.number().positive(),
  maxLossPercent: z.number().min(0).max(100),
  riskFreeRate: z.number().nonnegative().optional(),
  timeHorizonYears: z.number().positive(),
  portfolio: z.object({
    totalValue: z.number().positive(),
    holdings: z.array(z.object({
      assetClass: z.string().trim().min(1).max(80),
      marketValue: z.number().nonnegative(),
    })),
  }),
  targetAllocation: z.record(z.string(), z.number().min(0).max(1)),
});

atpRoutes.post("/shadow-evaluate", requireAuth, idempotentMutation(async (request, tx) => {
    const input = evaluationSchema.parse(request.body);
    const result = await evaluateAndPersist({
      ...input,
      userId: request.userId!,
      riskFreeRate: input.riskFreeRate ?? Number(process.env.ATP_RISK_FREE_RATE ?? "0.04"),
    }, tx);
    return { status: 200, body: { success: true, data: {
      ...result, signal: { ...result.signal, suggestedTrades: result.signal.suggestedTrades.map((trade) => ({ ...trade })) },
    } } };
}));
