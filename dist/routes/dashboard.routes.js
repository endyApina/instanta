"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dashboardRoutes = void 0;
const client_1 = require("@prisma/client");
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const app_error_1 = require("../errors/app-error");
const auth_1 = require("../middleware/auth");
const pii_service_1 = require("../services/pii.service");
const demo_1 = require("../config/demo");
exports.dashboardRoutes = (0, express_1.Router)();
exports.dashboardRoutes.get("/", auth_1.requireAuth, async (request, response, next) => {
    try {
        const data = await prisma_1.prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({
                where: { id: request.userId },
                select: {
                    id: true, email: true, firstName: true, lastName: true,
                    kycLevel: true, kycStatus: true, bvnLastFour: true, ninLastFour: true,
                    maxTolerableLoss: true, targetReturn: true, timeHorizonMonths: true,
                },
            });
            if (!user)
                throw new app_error_1.AppError(404, "USER_NOT_FOUND", "User was not found");
            const wallet = await tx.wallet.findUnique({
                where: { userId: user.id },
                select: {
                    status: true, currency: true, virtualAccountNumber: true,
                    virtualAccountName: true, virtualAccountBank: true,
                    ledgerAccount: { select: { balance: true } },
                },
            });
            const goals = await tx.savingsGoal.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: "desc" },
                include: { ledgerAccount: { select: { balance: true } } },
            });
            const activity = await tx.transaction.findMany({
                where: { ledgerAccount: { userId: user.id } },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 50,
                select: {
                    id: true, journalEntryId: true, side: true, amount: true, createdAt: true,
                    ledgerAccount: { select: { name: true } },
                    journalEntry: { select: { description: true } },
                },
            });
            if ((wallet && !wallet.ledgerAccount) || goals.some((goal) => !goal.ledgerAccount)) {
                throw new app_error_1.AppError(500, "LEDGER_ACCOUNT_MISSING", "An account ledger is missing. Contact support.");
            }
            await tx.auditEvent.create({ data: {
                    actorId: user.id, subjectId: user.id, action: "DASHBOARD_PII_READ",
                } });
            return {
                partnerMode: (0, demo_1.isDemoMode)() || ["KYC", "BAAS", "FUND", "SMS"].some((prefix) => !process.env[`${prefix}_GATEWAY_URL`] || !process.env[`${prefix}_API_KEY`])
                    ? "MOCK" : "LIVE",
                user: {
                    ...user,
                    email: (0, pii_service_1.decryptPii)(user.email), firstName: (0, pii_service_1.decryptPii)(user.firstName), lastName: (0, pii_service_1.decryptPii)(user.lastName),
                    maxTolerableLoss: user.maxTolerableLoss?.toString() ?? null,
                    targetReturn: user.targetReturn?.toString() ?? null,
                    timeHorizonMonths: user.timeHorizonMonths,
                },
                wallet: wallet ? {
                    status: wallet.status,
                    currency: wallet.currency,
                    balance: wallet.ledgerAccount.balance.toFixed(2),
                    virtualAccountNumber: wallet.virtualAccountNumber,
                    virtualAccountName: wallet.virtualAccountName,
                    virtualAccountBank: wallet.virtualAccountBank,
                } : null,
                goals: goals.map((goal) => ({
                    id: goal.id, name: goal.name, targetAmount: goal.targetAmount.toFixed(2),
                    lockedAmount: goal.lockedAmount.toFixed(2), yieldAccrued: goal.yieldAccrued.toFixed(2),
                    balance: goal.ledgerAccount.balance.toFixed(2),
                    autoSweep: goal.autoSweep, status: goal.status,
                    lockUntil: goal.lockUntil?.toISOString() ?? null,
                    endDate: goal.endDate?.toISOString() ?? null,
                })),
                activity: activity.map((line) => ({
                    id: line.id, journalEntryId: line.journalEntryId, side: line.side,
                    amount: line.amount.toFixed(2), createdAt: line.createdAt.toISOString(),
                    accountName: line.ledgerAccount.name, description: line.journalEntry.description,
                })),
            };
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead });
        response.setHeader("Cache-Control", "no-store");
        response.json({ success: true, data });
    }
    catch (error) {
        next(error);
    }
});
