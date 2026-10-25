"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const market_data_service_1 = require("../services/market-data.service");
const market_data_1 = require("../domain/market-data");
const session_service_1 = require("../services/session.service");
exports.marketRoutes = (0, express_1.Router)();
exports.marketRoutes.use(auth_1.requireAuth);
exports.marketRoutes.use(async (request, _response, next) => {
    try {
        await (0, session_service_1.enforceRateLimit)(`markets:${request.userId}`, 60, 60, "Too many market data requests. Try again shortly.");
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.marketRoutes.get("/instruments", async (request, response, next) => {
    try {
        const { provider } = zod_1.z.object({ provider: market_data_1.marketProviderSchema }).parse(request.query);
        response.json({ success: true, data: await market_data_service_1.marketData.catalog(provider) });
    }
    catch (error) {
        next(error);
    }
});
exports.marketRoutes.get("/history", async (request, response, next) => {
    try {
        const { provider, symbol, range } = zod_1.z.object({
            provider: market_data_1.marketProviderSchema, symbol: market_data_1.marketSymbolSchema, range: market_data_1.marketRangeSchema,
        }).parse(request.query);
        response.json({ success: true, data: await market_data_service_1.marketData.history(provider, symbol, range) });
    }
    catch (error) {
        next(error);
    }
});
