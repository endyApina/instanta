"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = void 0;
const client_1 = require("@prisma/client");
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../config/prisma");
const app_error_1 = require("../errors/app-error");
const auth_service_1 = require("../services/auth.service");
const ledger_service_1 = require("../services/ledger.service");
const pii_service_1 = require("../services/pii.service");
const session_service_1 = require("../services/session.service");
const jobs_service_1 = require("../services/jobs.service");
const idempotency_middleware_1 = require("../middleware/idempotency.middleware");
const auth_1 = require("../middleware/auth");
const recovery_service_1 = require("../services/recovery.service");
const demo_1 = require("../config/demo");
const demoMode_service_1 = require("../services/demoMode.service");
exports.authRoutes = (0, express_1.Router)();
const phone = zod_1.z.string().regex(/^\+234[789]\d{9}$/, "Enter your Nigerian mobile number with +234, such as +2348012345678.");
const registerSchema = zod_1.z.object({
    email: zod_1.z.string().trim().email().max(254),
    password: recovery_service_1.passwordSchema,
    firstName: zod_1.z.string().trim().min(1).max(100), lastName: zod_1.z.string().trim().min(1).max(100),
    phoneNumber: phone,
    bvn: zod_1.z.string().regex(/^\d{11}$/).optional(), nin: zod_1.z.string().regex(/^\d{11}$/).optional(),
    riskProfile: zod_1.z.object({
        maxTolerableLoss: zod_1.z.number().min(0).max(1), targetReturn: zod_1.z.number().min(0).max(10),
        timeHorizonMonths: zod_1.z.number().int().positive().max(1200),
    }).optional(),
}).refine((data) => data.bvn || data.nin, "BVN or NIN is required");
exports.authRoutes.use(async (request, _response, next) => {
    try {
        if (!["/register", "/login", "/verify-otp"].includes(request.path)) {
            next();
            return;
        }
        // Validation-only failures must not require a database round-trip or leak credentials.
        if (request.path === "/register")
            registerSchema.parse(request.body);
        if (request.path === "/login")
            zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string().min(1).max(128) }).parse(request.body);
        await (0, session_service_1.enforceRateLimit)(`auth-ip:${request.ip}`, 30, 900);
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/register", (0, idempotency_middleware_1.idempotentMutation)(async (request, tx) => {
    const input = registerSchema.parse(request.body);
    const user = await tx.user.create({
        data: {
            email: (0, pii_service_1.encryptPii)(input.email.toLowerCase()), emailLookupHash: (0, pii_service_1.piiLookupHash)(`email:${input.email.toLowerCase()}`),
            passwordHash: await (0, auth_service_1.hashPassword)(input.password),
            isDemo: (0, demo_1.isDemoMode)(),
            firstName: (0, pii_service_1.encryptPii)(input.firstName), lastName: (0, pii_service_1.encryptPii)(input.lastName), kycStatus: "PENDING",
            phoneEncrypted: (0, pii_service_1.encryptPii)(input.phoneNumber), phoneLookupHash: (0, pii_service_1.piiLookupHash)(`phone:${input.phoneNumber}`),
            bvnEncrypted: input.bvn ? (0, pii_service_1.encryptPii)(input.bvn) : undefined, bvnLastFour: input.bvn?.slice(-4),
            ninEncrypted: input.nin ? (0, pii_service_1.encryptPii)(input.nin) : undefined, ninLastFour: input.nin?.slice(-4),
            maxTolerableLoss: input.riskProfile ? new client_1.Prisma.Decimal(input.riskProfile.maxTolerableLoss.toFixed(4)) : undefined,
            targetReturn: input.riskProfile ? new client_1.Prisma.Decimal(input.riskProfile.targetReturn.toFixed(4)) : undefined,
            timeHorizonMonths: input.riskProfile?.timeHorizonMonths,
        },
    });
    const wallet = await tx.wallet.create({ data: { userId: user.id } });
    await (0, ledger_service_1.provisionLedgerAccounts)(tx, user.id, wallet.id);
    if ((0, demo_1.isDemoMode)())
        await (0, demoMode_service_1.seedDemoFunds)(tx, user.id);
    const verification = await tx.kycVerification.create({ data: { userId: user.id } });
    await (0, jobs_service_1.enqueue)(tx, "KYC", `kyc:${verification.id}`, { userId: user.id, verificationId: verification.id });
    await (0, jobs_service_1.enqueue)(tx, "VIRTUAL_ACCOUNT", `account:${user.id}`, { userId: user.id });
    await tx.auditEvent.create({ data: { actorId: user.id, subjectId: user.id, action: "REGISTERED" } });
    return { status: 201, body: { success: true, data: { registered: true, userId: user.id, message: "Account created. Sign in and complete OTP verification. Partner onboarding is queued." } } };
}, (request) => `register:${(0, session_service_1.secureHash)(registerSchema.parse(request.body).email.toLowerCase())}`));
exports.authRoutes.post("/login", async (request, response, next) => {
    try {
        const input = zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string().min(1).max(128) }).parse(request.body);
        const fingerprint = (0, session_service_1.deviceHash)(request);
        await (0, session_service_1.enforceRateLimit)(`login:${input.email.toLowerCase()}`, 10, 900);
        const user = await prisma_1.prisma.user.findUnique({ where: { emailLookupHash: (0, pii_service_1.piiLookupHash)(`email:${input.email.toLowerCase()}`) } });
        if (!user || user.isDemo !== (0, demo_1.isDemoMode)() || !(await (0, auth_service_1.verifyPassword)(input.password, user.passwordHash))) {
            throw new app_error_1.AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
        }
        response.json({ success: true, data: await (0, session_service_1.beginChallenge)(user.id, fingerprint, user.credentialVersion) });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/verify-otp", async (request, response, next) => {
    try {
        const input = zod_1.z.object({ challengeId: zod_1.z.string().uuid(), code: zod_1.z.string().regex(/^\d{6}$/) }).parse(request.body);
        response.json({ success: true, data: await (0, session_service_1.completeChallenge)(input.challengeId, input.code, (0, session_service_1.deviceHash)(request)) });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/logout", auth_1.requireAuth, async (request, response, next) => {
    try {
        await prisma_1.prisma.authSession.update({ where: { id: request.sessionId }, data: { revokedAt: new Date() } });
        response.json({ success: true, data: { signedOut: true } });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.use(["/forgot-password", "/verify-recovery-otp", "/reset-password"], async (request, _response, next) => {
    try {
        await (0, session_service_1.enforceRateLimit)(`recovery-ip:${request.ip}`, 30, 900, "Too many recovery attempts. Please wait 15 minutes.");
        next();
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/forgot-password", async (request, response, next) => {
    try {
        const input = zod_1.z.object({ contact: recovery_service_1.recoveryContactSchema.optional(), email: recovery_service_1.recoveryContactSchema.optional(), phone: recovery_service_1.recoveryContactSchema.optional() })
            .refine((value) => [value.contact, value.email, value.phone].filter(Boolean).length === 1, "Enter one email or phone number.").parse(request.body);
        response.json({ success: true, data: await (0, recovery_service_1.forgotPassword)(input.contact ?? input.email ?? input.phone, (0, session_service_1.deviceHash)(request)) });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/verify-recovery-otp", async (request, response, next) => {
    try {
        const input = zod_1.z.object({ challengeId: zod_1.z.string().uuid(), code: zod_1.z.string().regex(/^\d{6}$/, "Enter the six-digit code.") }).parse(request.body);
        response.json({ success: true, data: await (0, recovery_service_1.verifyRecoveryOtp)(input.challengeId, input.code, (0, session_service_1.deviceHash)(request)) });
    }
    catch (error) {
        next(error);
    }
});
exports.authRoutes.post("/reset-password", async (request, response, next) => {
    try {
        const input = zod_1.z.object({ resetToken: zod_1.z.string().regex(/^[a-f0-9]{64}$/), password: recovery_service_1.passwordSchema }).parse(request.body);
        response.json({ success: true, data: await (0, recovery_service_1.resetPassword)(input.resetToken, input.password, (0, session_service_1.deviceHash)(request)) });
    }
    catch (error) {
        next(error);
    }
});
