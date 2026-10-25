import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { idempotentMutation } from "../middleware/idempotency.middleware";
import { perpetualsService, type PreparedPaperOrder } from "../services/perpetuals.service";
import { globalAsset, paperOrderSchema, positiveGlobalDecimal, sizeLossBoundedPosition } from "../domain/perpetuals";
import { enforceRateLimit } from "../services/session.service";
import { isDemoMode } from "../config/demo";
import { AppError } from "../errors/app-error";

declare global {
  namespace Express {
    interface Request { preparedPaperOrder?: PreparedPaperOrder }
  }
}
export const perpetualsRoutes = Router();
perpetualsRoutes.use(requireAuth);
perpetualsRoutes.use(async (request, _response, next) => {
  try {
    await enforceRateLimit(`global:${request.userId!}`, 60, 60, "Too many global requests. Retry shortly.");
    next();
  } catch (error) { next(error); }
});
perpetualsRoutes.get("/symbols", async (_request, response, next) => {
  try { response.json({ success: true, data: await perpetualsService.symbols() }); }
  catch (error) { next(error); }
});
perpetualsRoutes.get("/portfolio", async (request, response, next) => {
  try { response.json({ success: true, data: await perpetualsService.snapshot(request.userId!) }); }
  catch (error) { next(error); }
});
perpetualsRoutes.post("/paper/fund", idempotentMutation(async (request, tx) => {
  if (isDemoMode()) throw new AppError(409, "DEMO_ALREADY_FUNDED", "Your demo starts with virtual funds. Refreshing or signing in again does not add more.");
  const input = z.object({ asset: globalAsset, amount: positiveGlobalDecimal }).parse(request.body);
  return { status: 201, body: { success: true, data: await perpetualsService.fundPaper(tx, request.userId!, input.asset, input.amount, request.header("idempotency-key")!) } };
}));
perpetualsRoutes.post("/risk-preview", async (request, response, next) => {
  try {
    const prepared = await perpetualsService.prepare(paperOrderSchema.parse(request.body));
    response.json({ success: true, data: { price: prepared.quote.price, risk: prepared.risk } });
  } catch (error) { next(error); }
});
perpetualsRoutes.post("/loss-budget", async (request, response, next) => {
  try {
    const input = z.object({
      principal: positiveGlobalDecimal, maxLossFraction: z.string(),
      unitPremium: positiveGlobalDecimal, fees: z.string(), qtyStep: positiveGlobalDecimal,
    }).parse(request.body);
    response.json({ success: true, data: { ...sizeLossBoundedPosition(input), scenarioOnly: true } });
  } catch (error) { next(error); }
});
perpetualsRoutes.post("/paper/orders", idempotentMutation(async (request, tx) => {
  return { status: 201, body: { success: true, data: await perpetualsService.placePaperOrder(
    tx, request.userId!, paperOrderSchema.parse(request.body), request.header("idempotency-key")!, request.preparedPaperOrder,
  ) } };
}, (request) => request.userId, async (request) => {
  // Network work happens before the posting transaction and only after committed-replay lookup.
  const input = paperOrderSchema.parse(request.body);
  if (!await perpetualsService.findReplay(request.userId!, request.header("idempotency-key")!, input)) {
    request.preparedPaperOrder = await perpetualsService.prepare(input);
  }
}));
