-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phoneEncrypted" TEXT,
ADD COLUMN     "phoneLookupHash" TEXT;

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "SavingsGoal" ALTER COLUMN "lockUntil" SET DATA TYPE TIMESTAMPTZ(3) USING "lockUntil" AT TIME ZONE 'UTC',
ALTER COLUMN "endDate" SET DATA TYPE TIMESTAMPTZ(3) USING "endDate" AT TIME ZONE 'UTC';

CREATE INDEX "SavingsGoal_status_lockUntil_idx" ON "SavingsGoal"("status", "lockUntil");

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WebhookInbox" (
    "id" TEXT NOT NULL,
    "transactionKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "payloadEncrypted" TEXT NOT NULL,
    "processedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "journalId" TEXT,

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "uniqueKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "deadAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SystemControl" (
    "id" TEXT NOT NULL,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SystemControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerExecution" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "nav" DECIMAL(20,6) NOT NULL,
    "units" DECIMAL(28,8) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookInbox_transactionKey_key" ON "WebhookInbox"("transactionKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxJob_uniqueKey_key" ON "OutboxJob"("uniqueKey");

-- CreateIndex
CREATE INDEX "OutboxJob_completedAt_deadAt_availableAt_idx" ON "OutboxJob"("completedAt", "deadAt", "availableAt");

-- CreateIndex
CREATE INDEX "AuthChallenge_userId_createdAt_idx" ON "AuthChallenge"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_subjectId_createdAt_idx" ON "AuditEvent"("subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneLookupHash_key" ON "User"("phoneLookupHash");
