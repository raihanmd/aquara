import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

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
