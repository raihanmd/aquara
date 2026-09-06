import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address: must be 0x + 40 hex chars");

const hexSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]*$/, "Invalid hex: must be 0x-prefixed hex");

const postBodySchema = z
  .object({
    delegator: addressSchema,
    delegate: addressSchema,
    chainId: z.coerce.number().int().positive().default(8453).optional(),
    delegation: z.unknown().optional(),
    delegationJson: z.unknown().optional(),
    caveats: z.unknown().optional(),
    signature: hexSchema.min(10, "signature too short").optional(),
    expiresAt: z
      .union([z.string(), z.number(), z.date()])
      .transform((v) => new Date(v as string | number | Date))
      .refine((d) => !isNaN(d.getTime()), { message: "Invalid expiresAt date" })
      .optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const hasDelegation = data.delegation !== undefined && data.delegation !== null;
    const hasDelegationJson = data.delegationJson !== undefined && data.delegationJson !== null;
    if (!hasDelegation && !hasDelegationJson) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "delegation or delegationJson is required",
        path: ["delegation"],
      });
    }
  });

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

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = postBodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const raw = parsed.data as unknown as Record<string, unknown>;
    const delegator = (raw.delegator as string).toLowerCase();
    const delegate = (raw.delegate as string).toLowerCase();
    const chainId = (raw.chainId as number) ?? 8453;

    let delegation: unknown = raw.delegation ?? raw.delegationJson;
    const caveats = raw.caveats;

    if (caveats !== undefined && delegation && typeof delegation === "object") {
      const d = delegation as Record<string, unknown>;
      if (!d.caveats) {
        delegation = { ...d, caveats };
      }
    }

    let signature = raw.signature as string | undefined;
    if (!signature && delegation && typeof delegation === "object") {
      const d = delegation as Record<string, unknown>;
      if (typeof d.signature === "string" && d.signature.startsWith("0x")) {
        signature = d.signature as string;
      }
    }

    if (!signature) {
      return Response.json(
        { error: "signature is required (top-level or inside delegation.signature)" },
        { status: 400 }
      );
    }

    const hexCheck = /^0x[a-fA-F0-9]*$/.test(signature);
    if (!hexCheck || signature.length < 10) {
      return Response.json({ error: "Invalid signature format" }, { status: 400 });
    }

    let expiresAt: Date | null = null;
    if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
      expiresAt = raw.expiresAt as Date;
      if (isNaN(expiresAt.getTime())) {
        return Response.json({ error: "Invalid expiresAt date" }, { status: 400 });
      }
      if (expiresAt.getTime() <= Date.now()) {
        return Response.json(
          { error: "expiresAt must be in the future" },
          { status: 400 }
        );
      }
    } else {
      expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      if (delegation && typeof delegation === "object") {
        const d = delegation as Record<string, unknown>;
        const maybeExp = (d.expiry as number) ?? (d.expiresAt as string | number);
        if (maybeExp) {
          const parsedExp = new Date(maybeExp as string | number);
          if (!isNaN(parsedExp.getTime()) && parsedExp.getTime() > Date.now()) {
            expiresAt = parsedExp;
          }
        }
      }
    }

    if (chainId !== 8453) {
      return Response.json(
        { error: "Unsupported chainId: only Base 8453 is allowed" },
        { status: 400 }
      );
    }

    const created = await prisma.delegation.create({
      data: {
        delegator,
        delegate,
        chainId,
        delegationJson: delegation as object,
        signature,
        expiresAt: expiresAt as Date,
      },
    });

    return Response.json(
      { data: toDelegationResponse(created as never) },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/delegations]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const delegator = searchParams.get("delegator");
    const delegate = searchParams.get("delegate");
    const chainIdParam = searchParams.get("chainId");
    const includeRevoked = searchParams.get("includeRevoked") === "true";

    const where: Record<string, unknown> = {};

    if (delegator) {
      const parsed = addressSchema.safeParse(delegator);
      if (!parsed.success) {
        return Response.json(
          { error: "Invalid delegator address" },
          { status: 400 }
        );
      }
      where.delegator = parsed.data.toLowerCase();
    }

    if (delegate) {
      const parsed = addressSchema.safeParse(delegate);
      if (!parsed.success) {
        return Response.json(
          { error: "Invalid delegate address" },
          { status: 400 }
        );
      }
      where.delegate = parsed.data.toLowerCase();
    }

    if (chainIdParam) {
      const n = Number(chainIdParam);
      if (!Number.isInteger(n) || n <= 0) {
        return Response.json({ error: "Invalid chainId" }, { status: 400 });
      }
      where.chainId = n;
    }

    if (!includeRevoked) {
      where.revoked = false;
    }

    const items = await prisma.delegation.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
    });

    const now = Date.now();
    const filtered = (items as unknown as Array<ReturnType<typeof toDelegationResponse> & { expiresAt: string | null }>).filter(
      (r) => {
        const rec = r as unknown as { expiresAt: Date | null };
        if (!rec.expiresAt) return true;
        return new Date(rec.expiresAt).getTime() > now;
      }
    );

    const data = (filtered as unknown as typeof items).map((r) =>
      toDelegationResponse(r as never)
    );

    return Response.json({ data });
  } catch (err) {
    console.error("[GET /api/delegations]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
