import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const maker = searchParams.get("maker");
  if (!maker) return Response.json({ error: "maker required" }, { status: 400 });
  const row = await (prisma as any).makerSettings.findUnique({
    where: { maker: maker.toLowerCase() },
  });
  return Response.json({ slippage: row?.slippage ?? 0.5 });
}

const postSchema = z.object({
  maker: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  slippage: z.coerce.number().min(0.05).max(10),
});

export async function POST(req: Request) {
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "maker + slippage (0.05-10) required" }, { status: 400 });
  }
  const { maker, slippage } = parsed.data;
  await (prisma as any).makerSettings.upsert({
    where: { maker: maker.toLowerCase() },
    update: { slippage },
    create: { maker: maker.toLowerCase(), slippage },
  });
  return Response.json({ ok: true, slippage });
}
