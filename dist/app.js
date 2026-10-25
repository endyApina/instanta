"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const node_path_1 = __importDefault(require("node:path"));
const atp_routes_1 = require("./routes/atp.routes");
const auth_routes_1 = require("./routes/auth.routes");
const savings_routes_1 = require("./routes/savings.routes");
const webhook_routes_1 = require("./routes/webhook.routes");
const error_handler_1 = require("./middleware/error-handler");
const dashboard_routes_1 = require("./routes/dashboard.routes");
const market_routes_1 = require("./routes/market.routes");
const perpetuals_routes_1 = require("./routes/perpetuals.routes");
const demo_routes_1 = require("./routes/demo.routes");
const wealth_routes_1 = require("./routes/wealth.routes");
const local_demo_proxy_1 = require("./services/local-demo-proxy");
const demo_1 = require("./config/demo");
exports.app = (0, express_1.default)();
exports.app.disable("x-powered-by");
exports.app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
});
exports.app.use((request, _response, next) => {
    if ((0, demo_1.isDemoMode)() && request.url.startsWith("/demo-api/v1/"))
        request.url = request.url.replace(/^\/demo-api/, "/api");
    next();
});
exports.app.use("/demo-api/v1", local_demo_proxy_1.proxyLocalDemo);
exports.app.use(express_1.default.json({
    limit: "1mb",
    verify: (request, _response, buffer) => {
        request.rawBody = Buffer.from(buffer);
    },
}));
exports.app.get("/health", (_request, response) => {
    response.json({ success: true, data: { status: "ok" } });
});
exports.app.get("/ready", async (_request, response, next) => {
    try {
        const { prisma } = await Promise.resolve().then(() => __importStar(require("./config/prisma")));
        await prisma.$queryRaw `SELECT 1`;
        response.json({ success: true, data: { status: "ready" } });
    }
    catch (error) {
        next(error);
    }
});
exports.app.use("/api/v1/auth", auth_routes_1.authRoutes);
exports.app.use("/api/v1/demo", demo_routes_1.demoRoutes);
exports.app.use("/api/v1/savings", savings_routes_1.savingsRoutes);
exports.app.use("/api/v1/atp", atp_routes_1.atpRoutes);
exports.app.use("/api/v1/webhooks", webhook_routes_1.webhookRoutes);
exports.app.use("/api/v1/dashboard", dashboard_routes_1.dashboardRoutes);
exports.app.use("/api/v1/markets", market_routes_1.marketRoutes);
exports.app.use("/api/v1/perpetuals", perpetuals_routes_1.perpetualsRoutes);
exports.app.use("/api/v1/wealth", wealth_routes_1.wealthRoutes, perpetuals_routes_1.perpetualsRoutes);
exports.app.use(express_1.default.static(node_path_1.default.join(__dirname, "web")));
exports.app.get("/app", (_request, response) => {
    response.setHeader("X-Robots-Tag", "noindex");
    response.sendFile(node_path_1.default.join(__dirname, "web", "index.html"));
});
exports.app.use((_request, response) => {
    response.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Route was not found" },
    });
});
exports.app.use(error_handler_1.errorHandler);
