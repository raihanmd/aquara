-- CreateTable
CREATE TABLE "delegations" (
    "id" TEXT NOT NULL,
    "delegator" VARCHAR(42) NOT NULL,
    "delegate" VARCHAR(42) NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 8453,
    "delegationJson" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_users" (
    "address" VARCHAR(42) NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 8453,
    "txHash" VARCHAR(66),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_users_pkey" PRIMARY KEY ("address")
);

-- CreateIndex
CREATE INDEX "delegations_delegator_idx" ON "delegations"("delegator");

-- CreateIndex
CREATE INDEX "delegations_delegate_idx" ON "delegations"("delegate");

-- CreateIndex
CREATE INDEX "delegations_chainId_idx" ON "delegations"("chainId");

-- CreateIndex
CREATE INDEX "delegations_expiresAt_idx" ON "delegations"("expiresAt");

-- CreateIndex
CREATE INDEX "managed_users_chainId_idx" ON "managed_users"("chainId");
