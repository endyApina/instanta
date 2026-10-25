"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.perpetualsRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const idempotency_middleware_1 = require("../middleware/idempotency.middleware");
const perpetuals_service_1 = require("../services/perpetuals.service");
const perpetuals_1 = require("../domain/perpetuals");
const session_service_1 = require("../services/session.service");
const demo_1 = require("../config/demo");
const app_error_1 = require("../errors/app-error");
exports.perpetualsRoutes = (0, express_1.Router)();
exports.perpetualsRoutes.use(auth_1.requireAuth);
exports.perpetualsRoutes.use(async (request, _response, next) => {
    try {
        await (0, session_service_1.enforceRateLimit)(`global:${request.userId}`, 60, 60, "Too many global requests. Retry shortly.");
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.perpetualsRoutes.get("/symbols", async (_request, response, next) => {
    try {
        response.json({ success: true, data: await perpetuals_service_1.perpetualsService.symbols() });
    }
    catch (error) {
        next(error);
    }
});
exports.perpetualsRoutes.get("/portfolio", async (request, response, next) => {
    try {
        response.json({ success: true, data: await perpetuals_service_1.perpetualsService.snapshot(request.userId) });
    }
    catch (error) {
        next(error);
    }
});
exports.perpetualsRoutes.post("/paper/fund", (0, idempotency_middleware_1.idempotentMutation)(async (request, tx) => {
    if ((0, demo_1.isDemoMode)())
        throw new app_error_1.AppError(409, "DEMO_ALREADY_FUNDED", "Your demo starts with virtual funds. Refreshing or signing in again does not add more.");
    const input = zod_1.z.object({ asset: perpetuals_1.globalAsset, amount: perpetuals_1.positiveGlobalDecimal }).parse(request.body);
    return { status: 201, body: { success: true, data: await perpetuals_service_1.perpetualsService.fundPaper(tx, request.userId, input.asset, input.amount, request.header("idempotency-key")) } };
}));
exports.perpetualsRoutes.post("/risk-preview", async (request, response, next) => {
    try {
        const prepared = await perpetuals_service_1.perpetualsService.prepare(perpetuals_1.paperOrderSchema.parse(request.body));
        response.json({ success: true, data: { price: prepared.quote.price, risk: prepared.risk } });
    }
    catch (error) {
        next(error);
    }
});
exports.perpetualsRoutes.post("/loss-budget", async (request, response, next) => {
    try {
        const input = zod_1.z.object({
            principal: perpetuals_1.positiveGlobalDecimal, maxLossFraction: zod_1.z.string(),
            unitPremium: perpetuals_1.positiveGlobalDecimal, fees: zod_1.z.string(), qtyStep: perpetuals_1.positiveGlobalDecimal,
        }).parse(request.body);
        response.json({ success: true, data: { ...(0, perpetuals_1.sizeLossBoundedPosition)(input), scenarioOnly: true } });
    }
    catch (error) {
        next(error);
    }
});
exports.perpetualsRoutes.post("/paper/orders", (0, idempotency_middleware_1.idempotentMutation)(async (request, tx) => {
    return { status: 201, body: { success: true, data: await perpetuals_service_1.perpetualsService.placePaperOrder(tx, request.userId, perpetuals_1.paperOrderSchema.parse(request.body), request.header("idempotency-key"), request.preparedPaperOrder) } };
}, (request) => request.userId, async (request) => {
    // Network work happens before the posting transaction and only after committed-replay lookup.
    const input = perpetuals_1.paperOrderSchema.parse(request.body);
    if (!await perpetuals_service_1.perpetualsService.findReplay(request.userId, request.header("idempotency-key"), input)) {
        request.preparedPaperOrder = await perpetuals_service_1.perpetualsService.prepare(input);
    }
}));
