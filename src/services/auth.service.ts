import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { AppError } from "../errors/app-error";

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new AppError(503, "AUTH_NOT_CONFIGURED", "JWT_SECRET must contain at least 32 bytes");
  }
  return secret;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function issueAccessToken(userId: string, sessionId: string, fingerprint: string): string {
  return jwt.sign({ device: fingerprint }, jwtSecret(), {
    subject: userId, jwtid: sessionId, expiresIn: "1h", issuer: "instanta-api", audience: "instanta-web",
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): { userId: string; sessionId: string; device: string } {
  try {
    const payload = jwt.verify(token, jwtSecret(), { issuer: "instanta-api", audience: "instanta-web", algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub || !payload.jti || typeof payload.device !== "string") {
      throw new Error("Invalid token subject");
    }
    return { userId: payload.sub, sessionId: payload.jti, device: payload.device };
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Bearer token is invalid or expired");
  }
}
