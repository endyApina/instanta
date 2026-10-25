"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.atpRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const atpEngine_service_1 = require("../services/atpEngine.service");
const idempotency_middleware_1 = require("../middleware/idempotency.middleware");
exports.atpRoutes = (0, express_1.Router)();
const evaluationSchema = zod_1.z.object({
    principal: zod_1.z.number().positive(),
    maxLossPercent: zod_1.z.number().min(0).max(100),
    riskFreeRate: zod_1.z.number().nonnegative().optional(),
    timeHorizonYears: zod_1.z.number().positive(),
    portfolio: zod_1.z.object({
        totalValue: zod_1.z.number().positive(),
        holdings: zod_1.z.array(zod_1.z.object({
            assetClass: zod_1.z.string().trim().min(1).max(80),
            marketValue: zod_1.z.number().nonnegative(),
        })),
    }),
    targetAllocation: zod_1.z.record(zod_1.z.string(), zod_1.z.number().min(0).max(1)),
});
exports.atpRoutes.post("/shadow-evaluate", auth_1.requireAuth, (0, idempotency_middleware_1.idempotentMutation)(async (request, tx) => {
    const input = evaluationSchema.parse(request.body);
    const result = await (0, atpEngine_service_1.evaluateAndPersist)({
        ...input,
        userId: request.userId,
        riskFreeRate: input.riskFreeRate ?? Number(process.env.ATP_RISK_FREE_RATE ?? "0.04"),
    }, tx);
    return { status: 200, body: { success: true, data: {
                ...result, signal: { ...result.signal, suggestedTrades: result.signal.suggestedTrades.map((trade) => ({ ...trade })) },
            } } };
}));
