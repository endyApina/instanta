import { z } from "zod";

export const marketProviderSchema = z.enum(["NGX", "FMDQ"]);
export const marketRangeSchema = z.enum(["1M", "3M", "1Y"]);
export const marketSymbolSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9 ._&/()-]+$/);
export const marketCategorySchema = z.enum(["EQUITY", "ETF", "TREASURY_BILL", "FGN_BOND", "RATE"]);
export const marketUnitSchema = z.enum(["NGN", "PERCENT", "PRICE_PER_100"]);
const decimal = z.string().regex(/^-?\d{1,15}(\.\d{1,10})?$/);

export const marketInstrumentSchema = z.object({
  symbol: marketSymbolSchema,
  name: z.string().min(1).max(180),
  category: marketCategorySchema,
  unit: marketUnitSchema,
});
export const marketCatalogSchema = z.object({
  provider: marketProviderSchema,
  instruments: z.array(marketInstrumentSchema).max(3000),
}).superRefine((catalog, context) => {
  if (new Set(catalog.instruments.map((item) => item.symbol)).size !== catalog.instruments.length) {
    context.addIssue({ code: "custom", message: "Duplicate market symbols" });
  }
});
export const marketHistorySchema = z.object({
  provider: marketProviderSchema,
  symbol: marketSymbolSchema,
  unit: marketUnitSchema,
  frequency: z.enum(["END_OF_DAY", "FIXING"]),
  fetchedAt: z.string().datetime(),
  points: z.array(z.object({ at: z.string().datetime(), value: decimal })).max(400),
}).superRefine((history, context) => {
  if (history.points.some((point, index) => index > 0 && point.at <= history.points[index - 1]!.at)) {
    context.addIssue({ code: "custom", message: "Market observations must be chronological and unique" });
  }
});

export type MarketProvider = z.infer<typeof marketProviderSchema>;
export type MarketRange = z.infer<typeof marketRangeSchema>;
export type MarketHistory = z.infer<typeof marketHistorySchema>;
export type MarketInstrument = z.infer<typeof marketInstrumentSchema>;
