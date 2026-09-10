import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const maker = searchParams.get("maker");
  const rows = await prisma.managedStrategy.findMany({
    where: {
      ...(maker ? { maker: maker.toLowerCase() } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return Response.json(rows);
}
