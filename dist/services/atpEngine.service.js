"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateDrift = exports.calculateFloorProtection = void 0;
exports.evaluateAndPersist = evaluateAndPersist;
const client_1 = require("@prisma/client");
const prisma_1 = require("../config/prisma");
const atp_1 = require("../domain/atp");
const transaction_service_1 = require("./transaction.service");
var atp_2 = require("../domain/atp");
Object.defineProperty(exports, "calculateFloorProtection", { enumerable: true, get: function () { return atp_2.calculateFloorProtection; } });
Object.defineProperty(exports, "evaluateDrift", { enumerable: true, get: function () { return atp_2.evaluateDrift; } });
async function evaluateAndPersist(input, tx = prisma_1.prisma) {
    await (0, transaction_service_1.assertWritable)(tx);
    const floor = (0, atp_1.calculateFloorProtection)(input.principal, input.maxLossPercent, input.riskFreeRate, input.timeHorizonYears);
    const signal = (0, atp_1.evaluateDrift)(input.portfolio, input.targetAllocation);
    const actualByClass = new Map();
    for (const holding of input.portfolio.holdings) {
        actualByClass.set(holding.assetClass, (actualByClass.get(holding.assetClass) ?? 0) + holding.marketValue);
    }
    const assetClasses = new Set([...Object.keys(input.targetAllocation), ...actualByClass.keys()]);
    const evaluation = await tx.portfolioEvaluation.create({
        data: {
            userId: input.userId,
            principal: new client_1.Prisma.Decimal(input.principal.toFixed(2)),
            maxLossPercent: new client_1.Prisma.Decimal(input.maxLossPercent.toFixed(4)),
            riskFreeRate: new client_1.Prisma.Decimal(input.riskFreeRate.toFixed(6)),
            timeHorizonYears: new client_1.Prisma.Decimal(input.timeHorizonYears.toFixed(4)),
            requiredTbills: new client_1.Prisma.Decimal(floor.requiredTbills.toFixed(2)),
            floorValue: new client_1.Prisma.Decimal(floor.floorValue.toFixed(2)),
            shouldRebalance: signal.shouldRebalance,
            allocations: {
                create: [...assetClasses].map((assetClass) => {
                    const drift = signal.targetVsActual[assetClass];
                    return {
                        assetClass,
                        targetPercentage: new client_1.Prisma.Decimal((drift.target / 100).toFixed(6)),
                        actualPercentage: new client_1.Prisma.Decimal((drift.actual / 100).toFixed(6)),
                        driftPercentagePoints: new client_1.Prisma.Decimal(drift.drift.toFixed(6)),
                        floorValue: assetClass.toLowerCase().includes("t-bill")
                            ? new client_1.Prisma.Decimal(floor.requiredTbills.toFixed(2))
                            : undefined,
                    };
                }),
            },
        },
        select: { id: true },
    });
    return { evaluationId: evaluation.id, ...floor, signal };
}
