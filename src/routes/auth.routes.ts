import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../errors/app-error";
import { hashPassword, verifyPassword } from "../services/auth.service";
import { provisionLedgerAccounts } from "../services/ledger.service";
import { encryptPii, piiLookupHash } from "../services/pii.service";
import { beginChallenge, completeChallenge, deviceHash, enforceRateLimit, secureHash } from "../services/session.service";
import { enqueue } from "../services/jobs.service";
import { idempotentMutation } from "../middleware/idempotency.middleware";
import { requireAuth } from "../middleware/auth";
import { forgotPassword, verifyRecoveryOtp, resetPassword, passwordSchema, recoveryContactSchema } from "../services/recovery.service";
import { isDemoMode } from "../config/demo";
import { seedDemoFunds } from "../services/demoMode.service";

export const authRoutes = Router();
const phone = z.string().regex(/^\+234[789]\d{9}$/, "Enter your Nigerian mobile number with +234, such as +2348012345678.");
const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100),
  phoneNumber: phone,
  bvn: z.string().regex(/^\d{11}$/).optional(), nin: z.string().regex(/^\d{11}$/).optional(),
  riskProfile: z.object({
    maxTolerableLoss: z.number().min(0).max(1), targetReturn: z.number().min(0).max(10),
    timeHorizonMonths: z.number().int().positive().max(1200),
  }).optional(),
}).refine((data) => data.bvn || data.nin, "BVN or NIN is required");

authRoutes.use(async (request, _response, next) => {
  try {
    if (!["/register", "/login", "/verify-otp"].includes(request.path)) { next(); return; }
    // Validation-only failures must not require a database round-trip or leak credentials.
    if (request.path === "/register") registerSchema.parse(request.body);
    if (request.path === "/login") z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).parse(request.body);
    await enforceRateLimit(`auth-ip:${request.ip}`, 30, 900);
    next();
  } catch (error) { next(error); }
});

authRoutes.post("/register", idempotentMutation(async (request, tx) => {
  const input = registerSchema.parse(request.body);
  const user = await tx.user.create({
    data: {
      email: encryptPii(input.email.toLowerCase()), emailLookupHash: piiLookupHash(`email:${input.email.toLowerCase()}`),
      passwordHash: await hashPassword(input.password),
      isDemo: isDemoMode(),
      firstName: encryptPii(input.firstName), lastName: encryptPii(input.lastName), kycStatus: "PENDING",
      phoneEncrypted: encryptPii(input.phoneNumber), phoneLookupHash: piiLookupHash(`phone:${input.phoneNumber}`),
      bvnEncrypted: input.bvn ? encryptPii(input.bvn) : undefined, bvnLastFour: input.bvn?.slice(-4),
      ninEncrypted: input.nin ? encryptPii(input.nin) : undefined, ninLastFour: input.nin?.slice(-4),
      maxTolerableLoss: input.riskProfile ? new Prisma.Decimal(input.riskProfile.maxTolerableLoss.toFixed(4)) : undefined,
      targetReturn: input.riskProfile ? new Prisma.Decimal(input.riskProfile.targetReturn.toFixed(4)) : undefined,
      timeHorizonMonths: input.riskProfile?.timeHorizonMonths,
    },
  });
  const wallet = await tx.wallet.create({ data: { userId: user.id } });
  await provisionLedgerAccounts(tx, user.id, wallet.id);
  if (isDemoMode()) await seedDemoFunds(tx, user.id);
  const verification = await tx.kycVerification.create({ data: { userId: user.id } });
  await enqueue(tx, "KYC", `kyc:${verification.id}`, { userId: user.id, verificationId: verification.id });
  await enqueue(tx, "VIRTUAL_ACCOUNT", `account:${user.id}`, { userId: user.id });
  await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: "REGISTERED" } });
  return { status: 201, body: { success: true, data: { registered: true, userId: user.id, message: "Account created. Sign in and complete OTP verification. Partner onboarding is queued." } } };
}, (request) => `register:${secureHash(registerSchema.parse(request.body).email.toLowerCase())}`));

authRoutes.post("/login", async (request, response, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).parse(request.body);
    const fingerprint = deviceHash(request);
    await enforceRateLimit(`login:${input.email.toLowerCase()}`, 10, 900);
    const user = await prisma.user.findUnique({ where: { emailLookupHash: piiLookupHash(`email:${input.email.toLowerCase()}`) } });
    if (!user || user.isDemo !== isDemoMode() || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }
    response.json({ success: true, data: await beginChallenge(user.id, fingerprint, user.credentialVersion) });
  } catch (error) { next(error); }
});

authRoutes.post("/verify-otp", async (request, response, next) => {
  try {
    const input = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    response.json({ success: true, data: await completeChallenge(input.challengeId, input.code, deviceHash(request)) });
  } catch (error) { next(error); }
});

authRoutes.post("/logout", requireAuth, async (request, response, next) => {
  try {
    await prisma.authSession.update({ where: { id: request.sessionId }, data: { revokedAt: new Date() } });
    response.json({ success: true, data: { signedOut: true } });
  } catch (error) { next(error); }
});

authRoutes.use(["/forgot-password", "/verify-recovery-otp", "/reset-password"], async (request, _response, next) => {
  try {
    await enforceRateLimit(`recovery-ip:${request.ip}`, 30, 900, "Too many recovery attempts. Please wait 15 minutes.");
    next();
  } catch (error) { next(error); }
});
authRoutes.post("/forgot-password", async (request, response, next) => {
  try {
    const input = z.object({ contact: recoveryContactSchema.optional(), email: recoveryContactSchema.optional(), phone: recoveryContactSchema.optional() })
      .refine((value) => [value.contact, value.email, value.phone].filter(Boolean).length === 1, "Enter one email or phone number.").parse(request.body);
    response.json({ success: true, data: await forgotPassword(input.contact ?? input.email ?? input.phone!, deviceHash(request)) });
  } catch (error) { next(error); }
});
authRoutes.post("/verify-recovery-otp", async (request, response, next) => {
  try {
    const input = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/, "Enter the six-digit code.") }).parse(request.body);
    response.json({ success: true, data: await verifyRecoveryOtp(input.challengeId, input.code, deviceHash(request)) });
  } catch (error) { next(error); }
});
authRoutes.post("/reset-password", async (request, response, next) => {
  try {
    const input = z.object({ resetToken: z.string().regex(/^[a-f0-9]{64}$/), password: passwordSchema }).parse(request.body);
    response.json({ success: true, data: await resetPassword(input.resetToken, input.password, deviceHash(request)) });
  } catch (error) { next(error); }
});
