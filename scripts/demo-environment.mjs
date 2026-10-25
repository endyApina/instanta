import { createHmac } from "node:crypto";

export function createDemoEnvironment(source, databasePort) {
  if (source.NODE_ENV === "production") throw new Error("Automatic local demo is not allowed in production.");
  if (!source.JWT_SECRET || source.JWT_SECRET.length < 32) throw new Error("Configure JWT_SECRET before starting the local demo.");
  const port = Number(source.LOCAL_DEMO_PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(source.PORT ?? "3000")) {
    throw new Error("LOCAL_DEMO_PORT must be a valid port different from PORT.");
  }
  const derive = (purpose) => createHmac("sha256", source.JWT_SECRET).update(`instanta-isolated-demo:${purpose}`).digest("hex");
  const url = new URL("postgresql://127.0.0.1/instanta_demo");
  url.username = "instanta_demo";
  url.password = derive("database");
  url.port = String(databasePort);
  return {
    ...source,
    NODE_ENV: source.NODE_ENV ?? "development",
    IS_DEMO_MODE: "true",
    ENABLE_LOCAL_DEMO: "false",
    PORT: String(port),
    HOST: "127.0.0.1",
    POSTGRES_USER: "instanta_demo",
    POSTGRES_PASSWORD: derive("database"),
    POSTGRES_DB: "instanta_demo",
    POSTGRES_PORT: String(databasePort),
    DATABASE_URL: url.href,
    COMPOSE_PROJECT_NAME: "instanta-demo-auto",
    JWT_SECRET: derive("jwt"),
    PII_ENCRYPTION_KEY: derive("pii"),
    BAAS_WEBHOOK_SECRET: derive("baas"),
    KYC_WEBHOOK_SECRET: derive("kyc"),
  };
}
