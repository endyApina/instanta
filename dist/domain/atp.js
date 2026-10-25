"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateFloorProtection = calculateFloorProtection;
exports.evaluateDrift = evaluateDrift;
const app_error_1 = require("../errors/app-error");
const money_1 = require("./money");
function calculateFloorProtection(principal, maxLossPercent, riskFreeRate, timeHorizonYears = 1) {
    if (!Number.isFinite(principal) || principal <= 0)
        throw new app_error_1.AppError(400, "INVALID_PRINCIPAL", "Principal must be a positive finite amount");
    if (!Number.isFinite(maxLossPercent) || maxLossPercent < 0 || maxLossPercent > 100)
        throw new app_error_1.AppError(400, "INVALID_MAX_LOSS", "Maximum loss percent must be between 0 and 100");
    if (!Number.isFinite(riskFreeRate) || riskFreeRate < 0)
        throw new app_error_1.AppError(400, "INVALID_RISK_FREE_RATE", "Risk-free rate must be a non-negative annual decimal");
    if (!Number.isFinite(timeHorizonYears) || timeHorizonYears <= 0)
        throw new app_error_1.AppError(400, "INVALID_TIME_HORIZON", "Time horizon must be a positive number of years");
    const floor = new money_1.MoneyDecimal(principal.toString()).mul(new money_1.MoneyDecimal(1).minus(new money_1.MoneyDecimal(maxLossPercent.toString()).div(100)));
    // Financial arithmetic is decimal; numeric conversion is confined to the legacy paper-simulation DTO.
    return {
        floorValue: floor.toNumber(),
        requiredTbills: floor.div(new money_1.MoneyDecimal(1).plus(new money_1.MoneyDecimal(riskFreeRate.toString()).mul(timeHorizonYears.toString()))).toNumber(),
    };
}
function evaluateDrift(portfolio, targets, thresholdPercentagePoints = 5) {
    if (!Number.isFinite(portfolio.totalValue) || portfolio.totalValue <= 0)
        throw new app_error_1.AppError(400, "INVALID_PORTFOLIO_VALUE", "Current portfolio total value must be positive");
    if (!Number.isFinite(thresholdPercentagePoints) || thresholdPercentagePoints <= 0)
        throw new app_error_1.AppError(400, "INVALID_DRIFT_THRESHOLD", "Drift threshold must be positive");
    const targetEntries = Object.entries(targets);
    if (!targetEntries.length || targetEntries.some(([, value]) => !Number.isFinite(value) || value < 0 || value > 1)
        || new money_1.MoneyDecimal(targetEntries.reduce((sum, [, value]) => sum.plus(value.toString()), new money_1.MoneyDecimal(0))).minus(1).abs().gt("0.0001")) {
        throw new app_error_1.AppError(400, "INVALID_ALLOCATION", "Target weights must be fractions between 0 and 1 and sum to 1");
    }
    const values = new Map();
    for (const holding of portfolio.holdings) {
        if (!Number.isFinite(holding.marketValue) || holding.marketValue < 0)
            throw new app_error_1.AppError(400, "INVALID_HOLDING", "Holding market values must be non-negative");
        values.set(holding.assetClass, (values.get(holding.assetClass) ?? new money_1.MoneyDecimal(0)).plus(holding.marketValue.toString()));
    }
    const total = new money_1.MoneyDecimal(portfolio.totalValue.toString());
    const sum = [...values.values()].reduce((acc, val) => acc.plus(val), new money_1.MoneyDecimal(0));
    if (sum.minus(total).abs().gt(money_1.MoneyDecimal.max("0.01", total.mul("0.0000000001"))))
        throw new app_error_1.AppError(400, "INVALID_PORTFOLIO_VALUE", "Holding values must sum to the portfolio total");
    const targetVsActual = Object.create(null);
    const exactDrifts = new Map();
    for (const asset of new Set([...Object.keys(targets), ...values.keys()])) {
        const target = new money_1.MoneyDecimal(Object.hasOwn(targets, asset) ? targets[asset].toString() : "0").mul(100);
        const actual = (values.get(asset) ?? new money_1.MoneyDecimal(0)).div(total).mul(100);
        const drift = target.minus(actual);
        exactDrifts.set(asset, drift);
        targetVsActual[asset] = { target: target.toNumber(), actual: actual.toNumber(), drift: drift.toNumber() };
    }
    const shouldRebalance = [...exactDrifts.values()].some((drift) => drift.abs().gt(new money_1.MoneyDecimal(thresholdPercentagePoints.toString()).plus("0.000000001")));
    const suggestedTrades = [];
    if (shouldRebalance)
        for (const [assetClass, drift] of exactDrifts) {
            if (drift.abs().gt("0.000000001"))
                suggestedTrades.push({
                    assetClass, side: drift.gt(0) ? "BUY" : "SELL",
                    amount: drift.abs().div(100).mul(total).toNumber(), driftPercentagePoints: drift.toNumber(),
                });
        }
    return { shouldRebalance, thresholdPercentagePoints, targetVsActual, suggestedTrades };
}
