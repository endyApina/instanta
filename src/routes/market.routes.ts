import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { marketData } from "../services/market-data.service";
import { marketProviderSchema, marketRangeSchema, marketSymbolSchema } from "../domain/market-data";
import { enforceRateLimit } from "../services/session.service";

export const marketRoutes = Router();
marketRoutes.use(requireAuth);
marketRoutes.use(async (request, _response, next) => {
  try {
    await enforceRateLimit(`markets:${request.userId!}`, 60, 60, "Too many market data requests. Try again shortly.");
    next();
  } catch (error) { next(error); }
});
marketRoutes.get("/instruments", async (request, response, next) => {
  try {
    const { provider } = z.object({ provider: marketProviderSchema }).parse(request.query);
    response.json({ success: true, data: await marketData.catalog(provider) });
  } catch (error) { next(error); }
});
marketRoutes.get("/history", async (request, response, next) => {
  try {
    const { provider, symbol, range } = z.object({
      provider: marketProviderSchema, symbol: marketSymbolSchema, range: marketRangeSchema,
    }).parse(request.query);
    response.json({ success: true, data: await marketData.history(provider, symbol, range) });
  } catch (error) { next(error); }
});
