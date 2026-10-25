ALTER TABLE "User" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "recoveryFailures" INTEGER NOT NULL DEFAULT 0 CHECK ("recoveryFailures" BETWEEN 0 AND 3),
 ADD COLUMN "recoveryLockedUntil" TIMESTAMPTZ(3);
ALTER TABLE "AuthChallenge" ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "PasswordRecovery" (
 id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
 "deviceHash" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "grantHash" TEXT UNIQUE,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "verifiedAt" TIMESTAMPTZ(3), "consumedAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PasswordRecovery_userId_createdAt_idx" ON "PasswordRecovery"("userId","createdAt");
CREATE INDEX "PasswordRecovery_expiresAt_idx" ON "PasswordRecovery"("expiresAt");
CREATE TABLE "DemoIdentity" (
 key TEXT PRIMARY KEY, "userId" TEXT NOT NULL UNIQUE REFERENCES "User"(id) ON DELETE RESTRICT
);
CREATE TABLE "DemoInstrument" (
 symbol TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
 asset TEXT NOT NULL CHECK (asset IN ('NGN','USD','USDT','USDC')),
 price DECIMAL(30,8) NOT NULL CHECK (price > 0),
 "tickSize" DECIMAL(30,8) NOT NULL CHECK ("tickSize" > 0),
 "qtyStep" DECIMAL(30,8) NOT NULL CHECK ("qtyStep" > 0),
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "GlobalPaperAccount" DROP CONSTRAINT "GlobalPaperAccount_asset_check";
ALTER TABLE "GlobalPaperJournal" DROP CONSTRAINT "GlobalPaperJournal_asset_check";
ALTER TABLE "GlobalPaperPosition" DROP CONSTRAINT "GlobalPaperPosition_asset_check";
ALTER TABLE "GlobalPaperOrder" DROP CONSTRAINT "GlobalPaperOrder_asset_check";
ALTER TABLE "GlobalPaperAccount" ADD CHECK (asset IN ('NGN','USD','USDT','USDC'));
ALTER TABLE "GlobalPaperJournal" ADD CHECK (asset IN ('NGN','USD','USDT','USDC'));
ALTER TABLE "GlobalPaperPosition" ADD CHECK (asset IN ('NGN','USD','USDT','USDC'));
ALTER TABLE "GlobalPaperOrder" ADD CHECK (asset IN ('NGN','USD','USDT','USDC'));
-- Outgoing demo transfers are debit-normal expenses in the simulated book.
ALTER TABLE "GlobalPaperAccount" DROP CONSTRAINT "GlobalPaperAccount_check";
ALTER TABLE "GlobalPaperAccount" ADD CHECK (
 ("normalBalance" = 'CREDIT' AND code IN ('SIMULATED_CAPITAL','REALIZED_GAIN'))
 OR ("normalBalance" = 'DEBIT' AND (code IN ('CASH','REALIZED_LOSS','DEMO_TRANSFER_OUT') OR code LIKE 'POSITION:%'))
);
