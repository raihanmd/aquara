import { PrismaClient } from "@prisma/client";

export interface DelegationRecord {
  id: string;
  delegator: string;
  delegate: string;
  chainId: number;
  delegationJson: unknown;
  signature: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  revoked: boolean;
  revokedAt: Date | null;
}

export interface ManagedUserRecord {
  address: string;
  chainId: number;
  txHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const globalForPrisma = globalThis as unknown as {
  __prisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = prisma;
}
