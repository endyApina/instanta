"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyKycResult = applyKycResult;
const client_1 = require("@prisma/client");
const app_error_1 = require("../errors/app-error");
const transaction_service_1 = require("./transaction.service");
async function applyKycResult(userId, verificationId, status, level) {
    await (0, transaction_service_1.serializable)(async (tx) => {
        await tx.$queryRaw `SELECT id FROM "KycVerification" WHERE id = ${verificationId} FOR UPDATE`;
        const verification = await tx.kycVerification.findUnique({ where: { id: verificationId } });
        if (!verification || verification.userId !== userId) {
            throw new app_error_1.AppError(404, "KYC_VERIFICATION_NOT_FOUND", "KYC verification was not found");
        }
        if (verification.status !== client_1.KycStatus.PENDING) {
            if (verification.status === status)
                return;
            throw new app_error_1.AppError(409, "KYC_ALREADY_FINAL", "Conflicting terminal KYC result");
        }
        await tx.kycVerification.update({
            where: { id: verificationId }, data: { status, completedAt: new Date() },
        });
        await tx.user.update({
            where: { id: userId }, data: { kycStatus: status, ...(status === "VERIFIED" && level ? { kycLevel: level } : {}) },
        });
        if (status === "VERIFIED")
            await tx.outboxJob.updateMany({
                where: { uniqueKey: `account:${userId}`, completedAt: null },
                data: { availableAt: new Date(), deadAt: null, attempts: 0 },
            });
        await tx.auditEvent.create({ data: { actorId: "kyc-partner", subjectId: userId, action: "KYC_RESULT" } });
    });
}
