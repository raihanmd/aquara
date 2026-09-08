-- CreateTable
CREATE TABLE "agent_decisions" (
    "id" TEXT NOT NULL,
    "maker" VARCHAR(42) NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 8453,
    "strategyHash" VARCHAR(66) NOT NULL,
    "pair" VARCHAR(64) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "reason" TEXT NOT NULL,
    "volume24h" DOUBLE PRECISION,
    "apy" DOUBLE PRECISION,
    "txHash" VARCHAR(66),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_strategies" (
    "strategyHash" VARCHAR(66) NOT NULL,
    "maker" VARCHAR(42) NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 8453,
    "mode" VARCHAR(16) NOT NULL,
    "capitalToken" VARCHAR(42) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_strategies_pkey" PRIMARY KEY ("strategyHash")
);

-- CreateIndex
CREATE INDEX "agent_decisions_maker_idx" ON "agent_decisions"("maker");

-- CreateIndex
CREATE INDEX "agent_decisions_createdAt_idx" ON "agent_decisions"("createdAt");

-- CreateIndex
CREATE INDEX "managed_strategies_maker_idx" ON "managed_strategies"("maker");
