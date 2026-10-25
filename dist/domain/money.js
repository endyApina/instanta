"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoneyDecimal = void 0;
exports.moneyAmount = moneyAmount;
const decimal_js_1 = __importDefault(require("decimal.js"));
const app_error_1 = require("../errors/app-error");
// Decimal arithmetic is shared with browser simulations; numbers only cross legacy API boundaries.
exports.MoneyDecimal = decimal_js_1.default.clone({ precision: 48, rounding: decimal_js_1.default.ROUND_HALF_UP });
function moneyAmount(value, allowZero = false) {
    if (!/^\d{1,18}(\.\d{1,2})?$/.test(value)) {
        throw new app_error_1.AppError(400, "INVALID_AMOUNT", "Amounts must be decimal strings with at most 18 integer and 2 fractional digits");
    }
    const amount = new exports.MoneyDecimal(value);
    if (allowZero ? amount.lt(0) : amount.lte(0)) {
        throw new app_error_1.AppError(400, "INVALID_AMOUNT", "Amount must be positive");
    }
    return amount;
}
