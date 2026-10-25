import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { AppError } from "../errors/app-error";

function encryptionKey(): Buffer {
  const value = process.env.PII_ENCRYPTION_KEY;
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new AppError(503, "PII_ENCRYPTION_NOT_CONFIGURED", "PII encryption is not configured");
  }
  return Buffer.from(value, "hex");
}

export function encryptPii(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

export function piiLookupHash(value: string): string {
  // Domain separation keeps blind lookup indexes distinct from encryption use.
  return createHmac("sha256", encryptionKey()).update(`instanta-lookup-v1:${value}`).digest("hex");
}

export function decryptPii(value: string): string {
  const [ivText, tagText, dataText] = value.split(".");
  if (!ivText || !tagText || !dataText) {
    throw new AppError(500, "INVALID_ENCRYPTED_PII", "Stored identity data is invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
