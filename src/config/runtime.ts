import { assertDemoConfiguration } from "./demo";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function validateRuntime(): void {
  assertDemoConfiguration();
  const environment = process.env.NODE_ENV ?? "development";
  if (!["development", "staging", "test", "production"].includes(environment)) {
    throw new Error("NODE_ENV must be development, staging, test or production");
  }
  if (process.env.SYSTEM_READ_ONLY_MODE !== undefined && !["true", "false"].includes(process.env.SYSTEM_READ_ONLY_MODE)) {
    throw new Error("SYSTEM_READ_ONLY_MODE must be true or false");
  }
  for (const name of ["JWT_SECRET", "BAAS_WEBHOOK_SECRET", "KYC_WEBHOOK_SECRET"]) {
    const value = process.env[name];
    if (!value || value.length < 32 || value.startsWith("replace-")) {
      throw new Error(`${name} must be configured with at least 32 random characters`);
    }
  }
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.PII_ENCRYPTION_KEY ?? "")) {
    throw new Error("PII_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters");
  }
}
