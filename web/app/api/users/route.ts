import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chainId = Number(searchParams.get("chainId") ?? 8453);
  const users = await prisma.managedUser.findMany({
    where: { chainId },
    orderBy: { updatedAt: "desc" },
  });
  return Response.json(users.map((u) => u.address));
}

const postSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.coerce.number().int().positive().default(8453).optional(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
});

export async function POST(req: Request) {
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "address required" }, { status: 400 });
  }
  const { address, chainId, txHash } = parsed.data;
  const user = await prisma.managedUser.upsert({
    where: { address: address.toLowerCase() },
    update: { chainId: chainId ?? 8453, ...(txHash ? { txHash } : {}) },
    create: { address: address.toLowerCase(), chainId: chainId ?? 8453, txHash },
  });
  return Response.json({ ok: true, address: user.address });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return Response.json({ error: "address required" }, { status: 400 });
  }
  await prisma.managedUser.deleteMany({
    where: { address: address.toLowerCase() },
  });
  return Response.json({ ok: true });
}
