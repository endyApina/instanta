import { z } from "zod";
import { instrumentSchema } from "./perpetuals";

export const wealthProductsSchema = z.object({
  products: z.array(z.object({
    id: z.string(), symbol: z.string(), name: z.string(), category: z.string(), currency: z.string(),
    source: z.enum(["NGX", "FMDQ", "PERPETUALS", "DEMO"]), instrument: instrumentSchema.optional(),
  })),
  unavailable: z.array(z.object({ source: z.string(), message: z.string() })),
});
export const wealthSummarySchema = z.object({
  demo: z.boolean(),
  totals: z.array(z.object({ currency: z.string(), mode: z.string(), amount: z.string() })),
  rows: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.string(), currency: z.string(), mode: z.string(),
    amount: z.string(), status: z.string(), detail: z.string(), yieldEarned: z.string().nullable(),
    protection: z.string(), drift: z.array(z.object({ asset: z.string(), percentagePoints: z.string() })),
    history: z.array(z.object({ at: z.string(), description: z.string(), amount: z.string() })),
  })),
});
export type WealthRow = z.infer<typeof wealthSummarySchema>["rows"][number];
