"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wealthSummarySchema = exports.wealthProductsSchema = void 0;
const zod_1 = require("zod");
const perpetuals_1 = require("./perpetuals");
exports.wealthProductsSchema = zod_1.z.object({
    products: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(), symbol: zod_1.z.string(), name: zod_1.z.string(), category: zod_1.z.string(), currency: zod_1.z.string(),
        source: zod_1.z.enum(["NGX", "FMDQ", "PERPETUALS", "DEMO"]), instrument: perpetuals_1.instrumentSchema.optional(),
    })),
    unavailable: zod_1.z.array(zod_1.z.object({ source: zod_1.z.string(), message: zod_1.z.string() })),
});
exports.wealthSummarySchema = zod_1.z.object({
    demo: zod_1.z.boolean(),
    totals: zod_1.z.array(zod_1.z.object({ currency: zod_1.z.string(), mode: zod_1.z.string(), amount: zod_1.z.string() })),
    rows: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(), name: zod_1.z.string(), kind: zod_1.z.string(), currency: zod_1.z.string(), mode: zod_1.z.string(),
        amount: zod_1.z.string(), status: zod_1.z.string(), detail: zod_1.z.string(), yieldEarned: zod_1.z.string().nullable(),
        protection: zod_1.z.string(), drift: zod_1.z.array(zod_1.z.object({ asset: zod_1.z.string(), percentagePoints: zod_1.z.string() })),
        history: zod_1.z.array(zod_1.z.object({ at: zod_1.z.string(), description: zod_1.z.string(), amount: zod_1.z.string() })),
    })),
});
