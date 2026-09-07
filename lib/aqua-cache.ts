import { prisma } from "@/lib/prisma";

function cacheModel() {
  const model = (prisma as any)?.aquaCache;
  if (!model || typeof model.findUnique !== "function") return null;
  return model;
}

export async function getCached<T>(key: string, ttlMs: number): Promise<T | null> {
  const model = cacheModel();
  if (!model) return null;
  const row = await model.findUnique({ where: { key } });
  if (!row) return null;
  if (Date.now() - new Date(row.updatedAt).getTime() > ttlMs) return null;
  return row.data as T;
}

export async function setCached(key: string, data: unknown): Promise<void> {
  const model = cacheModel();
  if (!model) return;
  await model.upsert({
    where: { key },
    update: { data: data as object },
    create: { key, data: data as object },
  });
}
