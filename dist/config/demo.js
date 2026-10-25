"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDemoMode = isDemoMode;
exports.assertDemoConfiguration = assertDemoConfiguration;
function isDemoMode() {
    return process.env.IS_DEMO_MODE === "true";
}
function assertDemoConfiguration() {
    if (process.env.IS_DEMO_MODE !== undefined && !["true", "false"].includes(process.env.IS_DEMO_MODE)) {
        throw new Error("IS_DEMO_MODE must be true or false");
    }
    if (!isDemoMode())
        return;
    const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
    if (process.env.NODE_ENV === "production" || !(database.endsWith("_demo") || (process.env.NODE_ENV === "test" && database.endsWith("_hardening_test")))) {
        throw new Error("Demo mode needs a separate database ending in _demo and cannot run in production");
    }
}
