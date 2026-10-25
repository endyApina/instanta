"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestHash = requestHash;
const node_crypto_1 = require("node:crypto");
const app_error_1 = require("../errors/app-error");
function requestHash(value) {
    function canonical(item, depth = 0) {
        if (depth > 20)
            throw new app_error_1.AppError(400, "INVALID_REQUEST", "Request nesting exceeds the supported depth");
        if (Array.isArray(item))
            return `[${item.map((val) => canonical(val, depth + 1)).join(",")}]`;
        if (item !== null && typeof item === "object") {
            return `{${Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val, depth + 1)}`).join(",")}}`;
        }
        return JSON.stringify(item) ?? "null";
    }
    return (0, node_crypto_1.createHash)("sha256").update(canonical(value)).digest("hex");
}
