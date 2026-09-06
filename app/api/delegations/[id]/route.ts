import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function toDelegationResponse(r: {
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
}) {
  return {
    id: r.id,
    delegator: r.delegator,
    delegate: r.delegate,
    chainId: r.chainId,
    delegation: r.delegationJson,
    signature: r.signature,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revoked: r.revoked,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }

    const record = await prisma.delegation.findUnique({
      where: { id },
    });

    if (!record) {
      return Response.json({ error: "Delegation not found" }, { status: 404 });
    }

    return Response.json({ data: toDelegationResponse(record as never) });
  } catch (err) {
    console.error("[GET /api/delegations/[id]]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }

    const existing = await prisma.delegation.findUnique({
      where: { id },
    });

    if (!existing) {
      return Response.json({ error: "Delegation not found" }, { status: 404 });
    }

    const rec = existing as unknown as { revoked: boolean };
    if (rec.revoked) {
      return Response.json({
        data: toDelegationResponse(existing as never),
        message: "Already revoked",
      });
    }

    try {
      const updated = await prisma.delegation.update({
        where: { id },
        data: {
          revoked: true,
          revokedAt: new Date(),
          updatedAt: new Date(),
        } as never,
      });
      return Response.json({ data: toDelegationResponse(updated as never) });
    } catch {
      await prisma.delegation.delete({ where: { id } });
      return Response.json({ data: null, message: "Delegation revoked" });
    }
  } catch (err) {
    console.error("[DELETE /api/delegations/[id]]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
