import { KycStatus } from "@prisma/client";
import { AppError } from "../errors/app-error";
import { serializable } from "./transaction.service";

export async function applyKycResult(
  userId: string, verificationId: string, status: "VERIFIED" | "REJECTED",
  level?: "TIER_1" | "TIER_2" | "TIER_3",
): Promise<void> {
  await serializable(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "KycVerification" WHERE id = ${verificationId} FOR UPDATE`;
    const verification = await tx.kycVerification.findUnique({ where: { id: verificationId } });
    if (!verification || verification.userId !== userId) {
      throw new AppError(404, "KYC_VERIFICATION_NOT_FOUND", "KYC verification was not found");
    }
    if (verification.status !== KycStatus.PENDING) {
      if (verification.status === status) return;
      throw new AppError(409, "KYC_ALREADY_FINAL", "Conflicting terminal KYC result");
    }
    await tx.kycVerification.update({
      where: { id: verificationId }, data: { status, completedAt: new Date() },
    });
    await tx.user.update({
      where: { id: userId }, data: { kycStatus: status, ...(status === "VERIFIED" && level ? { kycLevel: level } : {}) },
    });
    if (status === "VERIFIED") await tx.outboxJob.updateMany({
      where: { uniqueKey: `account:${userId}`, completedAt: null },
      data: { availableAt: new Date(), deadAt: null, attempts: 0 },
    });
    await tx.auditEvent.create({ data: { actorId: "kyc-partner", subjectId: userId, action: "KYC_RESULT" } });
  });
}
