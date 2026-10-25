"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.savingsRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const savings_service_1 = require("../services/savings.service");
const idempotency_middleware_1 = require("../middleware/idempotency.middleware");
exports.savingsRoutes = (0, express_1.Router)();
exports.savingsRoutes.post("/goals", auth_1.requireAuth, (0, idempotency_middleware_1.idempotentMutation)(async (request, tx) => {
    const input = zod_1.z.object({
        name: zod_1.z.string().trim().min(1).max(100),
        targetAmount: zod_1.z.string().regex(/^\d+(\.\d{1,2})?$/),
        initialAmount: zod_1.z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
        autoSweep: zod_1.z.boolean().default(false),
        lockUntil: zod_1.z.string().datetime().optional(),
        endDate: zod_1.z.string().datetime().optional(),
    }).parse(request.body);
    const goal = await (0, savings_service_1.createSavingsGoal)({
        ...input,
        userId: request.userId,
        lockUntil: input.lockUntil ? new Date(input.lockUntil) : undefined,
        endDate: input.endDate ? new Date(input.endDate) : undefined,
    }, tx);
    return { status: 201, body: { success: true, data: { goal } } };
}));
