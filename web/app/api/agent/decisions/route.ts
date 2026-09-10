import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const logSchema = z.object({
  maker: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  strategyHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  pair: z.string().min(1).max(64),
  action: z.enum(["dock", "ship", "watch", "keep", "review-fee"]),
  reason: z.string().min(1).max(500),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
});

// Rotator-only writer for off-pipeline events (docks). Gated by the same
// service key as the cron deploy path.
export async function POST(req: Request) {
  const cronKey = process.env.CRON_API_KEY;
  if (!cronKey || req.headers.get("x-cron-key") !== cronKey) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = logSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "maker, strategyHash, pair, action, reason required" }, { status: 400 });
  }
  const row = await prisma.agentDecision.create({
    data: {
      maker: parsed.data.maker.toLowerCase(),
      chainId: 8453,
      strategyHash: parsed.data.strategyHash,
      pair: parsed.data.pair,
      action: parsed.data.action,
      reason: parsed.data.reason,
      txHash: parsed.data.txHash ?? null,
    },
  });
  return Response.json({ ok: true, id: row.id });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const maker = searchParams.get("maker");
  const limit = Math.min(Number(searchParams.get("limit") ?? 20) || 20, 100);

  const rows = await prisma.agentDecision.findMany({
    where: maker ? { maker: maker.toLowerCase() } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return Response.json(rows);
}
