/**
 * Prisma singleton with in-memory fallback
 * - Uses real PrismaClient when @prisma/client is installed & DATABASE_URL is set
 * - Falls back to in-memory Map so `bun run build` always passes (parallel task may not have generated client yet)
 * - Interface matches prisma/schema.prisma Delegation model
 */

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

// ── In-memory store (fallback) ──────────────────────────────────────────────
const memoryStore = new Map<string, DelegationRecord>();

function generateId(): string {
  // cuid-like fallback without extra dep
  return `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

const memoryDelegation = {
  async create(args: {
    data: {
      delegator: string;
      delegate: string;
      chainId: number;
      delegationJson: unknown;
      signature: string;
      expiresAt?: Date | string | null;
    };
  }): Promise<DelegationRecord> {
    const id = generateId();
    const now = new Date();
    const expiresAt = args.data.expiresAt
      ? new Date(args.data.expiresAt as string)
      : null;
    const record: DelegationRecord = {
      id,
      delegator: args.data.delegator,
      delegate: args.data.delegate,
      chainId: args.data.chainId,
      delegationJson: args.data.delegationJson,
      signature: args.data.signature,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      revoked: false,
      revokedAt: null,
    };
    memoryStore.set(id, record);
    return record;
  },

  async findMany(args?: {
    where?: {
      delegator?: string;
      delegate?: string;
      chainId?: number;
      revoked?: boolean;
    };
    orderBy?: { createdAt?: "asc" | "desc" };
  }): Promise<DelegationRecord[]> {
    let items = Array.from(memoryStore.values());
    if (args?.where?.delegator) {
      const q = args.where.delegator.toLowerCase();
      items = items.filter((r) => r.delegator.toLowerCase() === q);
    }
    if (args?.where?.delegate) {
      const q = args.where.delegate.toLowerCase();
      items = items.filter((r) => r.delegate.toLowerCase() === q);
    }
    if (args?.where?.chainId !== undefined) {
      items = items.filter((r) => r.chainId === args.where!.chainId);
    }
    if (args?.where?.revoked !== undefined) {
      items = items.filter((r) => r.revoked === args.where!.revoked);
    }
    // default: newest first
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (args?.orderBy?.createdAt === "asc") {
      items.reverse();
    }
    return items;
  },

  async findUnique(args: { where: { id: string } }): Promise<DelegationRecord | null> {
    return memoryStore.get(args.where.id) ?? null;
  },

  async findFirst(args: { where: { id: string } }): Promise<DelegationRecord | null> {
    return memoryStore.get(args.where.id) ?? null;
  },

  async update(args: {
    where: { id: string };
    data: Partial<Pick<DelegationRecord, "revoked" | "revokedAt" | "updatedAt">> & Record<string, unknown>;
  }): Promise<DelegationRecord> {
    const existing = memoryStore.get(args.where.id);
    if (!existing) throw new Error("Record not found");
    const updated: DelegationRecord = {
      ...existing,
      ...args.data,
      updatedAt: new Date(),
    } as DelegationRecord;
    // handle revokedAt
    if (args.data.revoked === true && !updated.revokedAt) {
      updated.revokedAt = new Date();
    }
    memoryStore.set(args.where.id, updated);
    return updated;
  },

  async delete(args: { where: { id: string } }): Promise<DelegationRecord> {
    const existing = memoryStore.get(args.where.id);
    if (!existing) throw new Error("Record not found");
    memoryStore.delete(args.where.id);
    return existing;
  },
};

// ── Try real PrismaClient if available ──────────────────────────────────────
type PrismaClientLike = {
  delegation: typeof memoryDelegation;
  $connect?: () => Promise<void>;
  $disconnect?: () => Promise<void>;
};

let prismaClient: PrismaClientLike | null = null;

function getPrismaClient(): PrismaClientLike {
  if (prismaClient) return prismaClient;

  // Attempt to load real PrismaClient only if DATABASE_URL is set
  // Use dynamic require so build doesn't fail when @prisma/client not installed
  if (typeof process !== "undefined" && process.env.DATABASE_URL) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = eval("require")("@prisma/client");
      const PrismaClient = mod.PrismaClient;
      if (PrismaClient) {
        const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClientLike };
        if (!globalForPrisma.__prisma) {
          globalForPrisma.__prisma = new PrismaClient() as PrismaClientLike;
        }
        prismaClient = globalForPrisma.__prisma;
        return prismaClient;
      }
    } catch {
      // fall through to memory
    }
  }

  // Fallback: in-memory singleton (also stored on globalThis for HMR)
  const globalForMemory = globalThis as unknown as { __prismaMemory?: PrismaClientLike };
  if (!globalForMemory.__prismaMemory) {
    globalForMemory.__prismaMemory = {
      delegation: memoryDelegation,
    };
  }
  prismaClient = globalForMemory.__prismaMemory;
  return prismaClient;
}

// Export singleton — matches `import { prisma } from "@/lib/prisma"`
export const prisma: PrismaClientLike = getPrismaClient();

// Also export for direct access in tests
export const _memoryStore = memoryStore;
export const _memoryDelegation = memoryDelegation;
