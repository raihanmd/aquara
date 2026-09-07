import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  strategyHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  maker: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.coerce.number().int().positive().default(8453).optional(),
  mode: z.enum(["conservative", "aggressive"]).default("conservative"),
  capitalToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

export async function POST(req: Request) {
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
  const rows = await prisma.managedStrategy.findMany({
    where: maker ? { maker: maker.toLowerCase() } : {},
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return Response.json(rows);
}
