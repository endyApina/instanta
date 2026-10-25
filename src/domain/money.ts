import Decimal from "decimal.js";
import { AppError } from "../errors/app-error";

// Decimal arithmetic is shared with browser simulations; numbers only cross legacy API boundaries.
export const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export function moneyAmount(value: string, allowZero = false): Decimal {
  if (!/^\d{1,18}(\.\d{1,2})?$/.test(value)) {
    throw new AppError(400, "INVALID_AMOUNT", "Amounts must be decimal strings with at most 18 integer and 2 fractional digits");
  }
  const amount = new MoneyDecimal(value);
  if (allowZero ? amount.lt(0) : amount.lte(0)) {
    throw new AppError(400, "INVALID_AMOUNT", "Amount must be positive");
  }
  return amount;
}
