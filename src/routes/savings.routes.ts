import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createSavingsGoal } from "../services/savings.service";
import { idempotentMutation } from "../middleware/idempotency.middleware";

export const savingsRoutes = Router();

savingsRoutes.post("/goals", requireAuth, idempotentMutation(async (request, tx) => {
    const input = z.object({
      name: z.string().trim().min(1).max(100),
      targetAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
      initialAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
      autoSweep: z.boolean().default(false),
      lockUntil: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    }).parse(request.body);
    const goal = await createSavingsGoal({
      ...input,
      userId: request.userId!,
      lockUntil: input.lockUntil ? new Date(input.lockUntil) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
    }, tx);
    return { status: 201, body: { success: true, data: { goal } } };
}));
