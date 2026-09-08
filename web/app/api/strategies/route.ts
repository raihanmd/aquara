import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCre } from "@/lib/cre-auth";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  strategyHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  maker: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.coerce.number().int().positive().default(8453).optional(),
  mode: z.enum(["conservative", "aggressive"]).default("conservative"),
  capitalToken: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0x0000000000000000000000000000000000000000"),
});

export async function POST(req: Request) {
  const denied = requireCre(req);
  if (denied) return denied;
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "strategyHash, maker, mode, capitalToken required" }, { status: 400 });
  }
  const { strategyHash, maker, chainId, mode, capitalToken } = parsed.data;
  const row = await prisma.managedStrategy.upsert({
    where: { strategyHash },
    update: { mode, capitalToken, chainId: chainId ?? 8453 },
    create: {
      strategyHash,
      maker: maker.toLowerCase(),
      chainId: chainId ?? 8453,
      mode,
      capitalToken,
    },
  });
  return Response.json({ ok: true, strategyHash: row.strategyHash, mode: row.mode });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const maker = searchParams.get("maker");
  const mode = searchParams.get("mode");
  const rows = await prisma.managedStrategy.findMany({
    where: {
      ...(maker ? { maker: maker.toLowerCase() } : {}),
      ...(mode === "aggressive" || mode === "conservative" ? { mode } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return Response.json(rows);
}

export async function DELETE(req: Request) {
  const denied = requireCre(req);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const strategyHash = searchParams.get("strategyHash") ?? "";
  const maker = searchParams.get("maker") ?? "";
  if (!/^0x[a-fA-F0-9]{64}$/.test(strategyHash) || !/^0x[a-fA-F0-9]{40}$/.test(maker)) {
    return Response.json({ error: "strategyHash, maker required" }, { status: 400 });
  }
  const row = await prisma.managedStrategy.findUnique({ where: { strategyHash } });
  if (!row || row.maker.toLowerCase() !== maker.toLowerCase()) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  await prisma.managedStrategy.delete({ where: { strategyHash } });
  return Response.json({ ok: true, strategyHash });
}
