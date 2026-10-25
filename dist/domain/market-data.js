"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketHistorySchema = exports.marketCatalogSchema = exports.marketInstrumentSchema = exports.marketUnitSchema = exports.marketCategorySchema = exports.marketSymbolSchema = exports.marketRangeSchema = exports.marketProviderSchema = void 0;
const zod_1 = require("zod");
exports.marketProviderSchema = zod_1.z.enum(["NGX", "FMDQ"]);
exports.marketRangeSchema = zod_1.z.enum(["1M", "3M", "1Y"]);
exports.marketSymbolSchema = zod_1.z.string().min(1).max(80).regex(/^[A-Za-z0-9 ._&/()-]+$/);
exports.marketCategorySchema = zod_1.z.enum(["EQUITY", "ETF", "TREASURY_BILL", "FGN_BOND", "RATE"]);
exports.marketUnitSchema = zod_1.z.enum(["NGN", "PERCENT", "PRICE_PER_100"]);
const decimal = zod_1.z.string().regex(/^-?\d{1,15}(\.\d{1,10})?$/);
exports.marketInstrumentSchema = zod_1.z.object({
    symbol: exports.marketSymbolSchema,
    name: zod_1.z.string().min(1).max(180),
    category: exports.marketCategorySchema,
    unit: exports.marketUnitSchema,
});
exports.marketCatalogSchema = zod_1.z.object({
    provider: exports.marketProviderSchema,
    instruments: zod_1.z.array(exports.marketInstrumentSchema).max(3000),
}).superRefine((catalog, context) => {
    if (new Set(catalog.instruments.map((item) => item.symbol)).size !== catalog.instruments.length) {
        context.addIssue({ code: "custom", message: "Duplicate market symbols" });
    }
});
exports.marketHistorySchema = zod_1.z.object({
    provider: exports.marketProviderSchema,
    symbol: exports.marketSymbolSchema,
    unit: exports.marketUnitSchema,
    frequency: zod_1.z.enum(["END_OF_DAY", "FIXING"]),
    fetchedAt: zod_1.z.string().datetime(),
    points: zod_1.z.array(zod_1.z.object({ at: zod_1.z.string().datetime(), value: decimal })).max(400),
}).superRefine((history, context) => {
    if (history.points.some((point, index) => index > 0 && point.at <= history.points[index - 1].at)) {
        context.addIssue({ code: "custom", message: "Market observations must be chronological and unique" });
    }
});
