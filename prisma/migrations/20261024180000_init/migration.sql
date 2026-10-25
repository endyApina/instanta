-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "KycLevel" AS ENUM ('TIER_1', 'TIER_2', 'TIER_3');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "LedgerSide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "SavingsGoalStatus" AS ENUM ('ACTIVE', 'LOCKED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "kycLevel" "KycLevel" NOT NULL DEFAULT 'TIER_1',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "bvnEncrypted" TEXT,
    "bvnLastFour" TEXT,
    "ninEncrypted" TEXT,
    "ninLastFour" TEXT,
    "maxTolerableLoss" DECIMAL(7,4),
    "targetReturn" DECIMAL(7,4),
    "timeHorizonMonths" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "virtualAccountBank" TEXT,
    "virtualAccountName" TEXT,
    "virtualAccountNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "normalBalance" "LedgerSide" NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "balance" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "isSystemAccount" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    "walletId" TEXT,
    "savingsGoalId" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "externalReference" TEXT,
    "description" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "status" "JournalStatus" NOT NULL DEFAULT 'POSTED',
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "ledgerAccountId" TEXT NOT NULL,
    "side" "LedgerSide" NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsGoal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmount" DECIMAL(20,2) NOT NULL,
    "lockedAmount" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "yieldAccrued" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "autoSweep" BOOLEAN NOT NULL DEFAULT false,
    "status" "SavingsGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "lockUntil" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioEvaluation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "principal" DECIMAL(20,2) NOT NULL,
    "maxLossPercent" DECIMAL(7,4) NOT NULL,
    "riskFreeRate" DECIMAL(7,6) NOT NULL,
    "timeHorizonYears" DECIMAL(8,4) NOT NULL,
    "requiredTbills" DECIMAL(20,2) NOT NULL,
    "floorValue" DECIMAL(20,2) NOT NULL,
    "shouldRebalance" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioAllocation" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL,
    "targetPercentage" DECIMAL(9,6) NOT NULL,
    "actualPercentage" DECIMAL(9,6) NOT NULL,
    "driftPercentagePoints" DECIMAL(9,6) NOT NULL,
    "floorValue" DECIMAL(20,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerReference" TEXT,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "KycVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_virtualAccountNumber_key" ON "Wallet"("virtualAccountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_walletId_key" ON "LedgerAccount"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_savingsGoalId_key" ON "LedgerAccount"("savingsGoalId");

-- CreateIndex
CREATE INDEX "LedgerAccount_userId_accountType_idx" ON "LedgerAccount"("userId", "accountType");

-- CreateIndex
CREATE INDEX "LedgerAccount_parentId_idx" ON "LedgerAccount"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_idempotencyKey_key" ON "JournalEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JournalEntry_externalReference_idx" ON "JournalEntry"("externalReference");

-- CreateIndex
CREATE INDEX "JournalEntry_postedAt_idx" ON "JournalEntry"("postedAt");

-- CreateIndex
CREATE INDEX "Transaction_ledgerAccountId_createdAt_idx" ON "Transaction"("ledgerAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_journalEntryId_idx" ON "Transaction"("journalEntryId");

-- CreateIndex
CREATE INDEX "SavingsGoal_userId_status_idx" ON "SavingsGoal"("userId", "status");

-- CreateIndex
CREATE INDEX "SavingsGoal_endDate_idx" ON "SavingsGoal"("endDate");

-- CreateIndex
CREATE INDEX "PortfolioEvaluation_userId_createdAt_idx" ON "PortfolioEvaluation"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioAllocation_evaluationId_assetClass_key" ON "PortfolioAllocation"("evaluationId", "assetClass");

-- CreateIndex
CREATE UNIQUE INDEX "KycVerification_providerReference_key" ON "KycVerification"("providerReference");

-- CreateIndex
CREATE INDEX "KycVerification_userId_requestedAt_idx" ON "KycVerification"("userId", "requestedAt");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_savingsGoalId_fkey" FOREIGN KEY ("savingsGoalId") REFERENCES "SavingsGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioEvaluation" ADD CONSTRAINT "PortfolioEvaluation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioAllocation" ADD CONSTRAINT "PortfolioAllocation_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "PortfolioEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycVerification" ADD CONSTRAINT "KycVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
