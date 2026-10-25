"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.demoRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const demo_1 = require("../config/demo");
const session_service_1 = require("../services/session.service");
const demoMode_service_1 = require("../services/demoMode.service");
const auth_1 = require("../middleware/auth");
const idempotency_middleware_1 = require("../middleware/idempotency.middleware");
const local_demo_proxy_1 = require("../services/local-demo-proxy");
exports.demoRoutes = (0, express_1.Router)();
exports.demoRoutes.get("/config", (_request, response) => response.json({ success: true, data: { enabled: (0, demo_1.isDemoMode)(), localDemoAvailable: (0, local_demo_proxy_1.localDemoEnabled)() } }));
exports.demoRoutes.post("/session", async (request, response, next) => {
    try {
        (0, demoMode_service_1.requireDemoMode)();
        await (0, session_service_1.enforceRateLimit)(`demo-ip:${request.ip}`, 10, 900, "Too many demo sign-ins. Please wait 15 minutes.");
        const { identity } = zod_1.z.object({ identity: zod_1.z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
        response.json({ success: true, data: await (0, demoMode_service_1.openDemoSession)(identity, (0, session_service_1.deviceHash)(request)) });
    }
    catch (error) {
        next(error);
    }
});
exports.demoRoutes.post("/rebalance", auth_1.requireAuth, (0, idempotency_middleware_1.idempotentMutation)(async (request, tx) => ({
    status: 200, body: { success: true, data: await (0, demoMode_service_1.rebalanceDemo)(tx, request.userId) },
})));
