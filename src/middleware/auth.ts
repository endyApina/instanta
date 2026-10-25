import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/app-error";
import { verifyAccessToken } from "../services/auth.service";
import { prisma } from "../config/prisma";
import { deviceFingerprint } from "../services/session.service";
import { isDemoMode } from "../config/demo";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
    }
  }
}

export async function requireAuth(request: Request, _response: Response, next: NextFunction): Promise<void> {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    next(new AppError(401, "UNAUTHORIZED", "Please sign in to continue."));
    return;
  }
  try {
    const session = await authenticateSession(authorization.slice(7), request.header("x-device-id"), request.ip ?? request.socket.remoteAddress ?? "unknown");
    request.userId = session.userId;
    request.sessionId = session.id;
    next();
  } catch (error) {
    next(error);
  }
}

export async function authenticateSession(token: string, deviceId: string | undefined, ip: string) {
  const claims = verifyAccessToken(token);
  const fingerprint = deviceFingerprint(deviceId, ip);
  if (claims.device !== fingerprint) {
    throw new AppError(401, "MFA_REQUIRED", "You're using a different device or connection. Please sign in again and confirm the code sent to your phone.");
  }
  const session = await prisma.authSession.findUnique({ where: { id: claims.sessionId } });
  if (!session || session.revokedAt || session.userId !== claims.userId || session.deviceHash !== fingerprint || session.expiresAt <= new Date()) {
    throw new AppError(401, "UNAUTHORIZED", "Session expired or revoked. Sign in again.");
  }
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.isDemo !== isDemoMode()) throw new AppError(401, "ACCOUNT_MODE_MISMATCH", "This account belongs to a different environment. Please sign in here.");
  if (user.recoveryLockedUntil && user.recoveryLockedUntil > new Date()) throw new AppError(401, "ACCOUNT_TEMPORARILY_LOCKED", "Your account is temporarily locked. Please wait one hour before signing in again.");
  return session;
}
