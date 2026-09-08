import { prisma } from "@/lib/prisma";
import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  type Address,
} from "viem";
import { base } from "viem/chains";

export const dynamic = "force-dynamic";

const AQUA_BASE = "https://api.1inch.com/aqua/v1.0";
const CALIBUR_RPC =
  process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.base.org";

function computeKeyHash(agentAddress: Address): `0x${string}` {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }], [agentAddress]));
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }],
      [2, inner]
    )
  );
}

async function isKeyRegistered(
  userEOA: string,
  agentAddress: string
): Promise<boolean | null> {
  try {
    const client = createPublicClient({ chain: base, transport: http(CALIBUR_RPC) });
    const keyHash = computeKeyHash(agentAddress as Address);
    const registered = (await client.readContract({
      address: userEOA as Address,
      abi: [
        {
          name: "isRegistered",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "keyHash", type: "bytes32" }],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      functionName: "isRegistered",
      args: [keyHash],
    })) as boolean;
    return registered;
  } catch {
    return null;
  }
}

type Decision = {
  maker: string;
  chainId: number;
  strategyHash: string;
  pair: string;
  action: "dock" | "review-fee" | "watch" | "keep";
  reason: string;
  volume24h: number | null;
  volume7d: number | null;
  apy: number | null;
  state: string | null;
};

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function pairOf(tokens: any[]): string {
  const s = (tokens ?? []).map((t: any) => t?.meta?.symbol ?? t?.symbol ?? "?");
  return s.slice(0, 2).join(" / ") || "?";
}

async function evaluateMaker(
  maker: string,
  apiKey: string,
): Promise<Decision[]> {
  const out: Decision[] = [];
  const res = await fetch(
    `${AQUA_BASE}/strategies/makers/${maker}?limit=20&chainIds=8453`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) throw new Error(`Aqua API ${res.status} for ${maker}`);
  const json = await res.json();
  const items: any[] = json.items ?? [];

  const vols = items.map((s) => num(s?.performance?.volume?.last24h?.usd) ?? 0);
  const medianVol =
    [...vols].sort((a, b) => a - b)[Math.floor(vols.length / 2)] ?? 0;

  for (const s of items) {
    const perf = s.performance ?? {};
    const v24 = num(perf?.volume?.last24h?.usd);
    const v7 = num(perf?.volume?.last7d?.usd);
    const apy =
      num(perf?.fees?.last24h?.apy) ??
      num(perf?.fees?.last7d?.apy) ??
      num(perf?.fees?.total?.apy);
    const state = (s.classification as any)?.state ?? null;
    const tokens: any[] = s.tokens ?? [];
    const singleSided = tokens.some((t: any) => {
      const raw = t?.currentBalance?.raw ?? t?.currentBalance;
      return raw !== undefined && String(raw) === "0";
    });

    const d: Decision = {
      maker,
      chainId: s.chainId ?? 8453,
      strategyHash: s.strategyHash,
      pair: pairOf(tokens),
      action: "keep",
      reason: "healthy",
      volume24h: v24,
      volume7d: v7,
      apy,
      state,
    };

    if (state === "illiquidity" || singleSided) {
      d.action = "dock";
      d.reason = singleSided
        ? "single-sided (one token drained to 0), capital idle"
        : "illiquid - no fills expected";
    } else if ((v24 ?? 0) === 0 && (v7 ?? 0) === 0) {
      d.action = "dock";
      d.reason = "zero volume 24h + 7d, dead weight on shared balance";
    } else if (v24 != null && v7 != null && v7 > 0 && v24 < v7 / 7 / 2) {
      d.action = "watch";
      d.reason = "24h pace < half of 7d daily average, volume fading";
    } else if ((v24 ?? 0) > 0 && (v24 ?? 0) < medianVol / 10 && medianVol > 0) {
      d.action = "review-fee";
      d.reason = "fills far below sibling strategies, fee tier may be too high";
    }
    out.push(d);
  }
  return out;
}

export async function GET(req: Request) {
  const apiKey =
    process.env.ONEINCH_API_KEY || process.env.NEXT_PUBLIC_1INCH_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ONEINCH_API_KEY missing" }, { status: 500 });
  }
  const { searchParams } = new URL(req.url);
  const onlyMaker = searchParams.get("maker");

  const agentAddress =
    process.env.NEXT_PUBLIC_AGENT_ADDRESS || process.env.AGENT_ADDRESS || "";

  let makers: string[] = [];
  let pruned: string[] = [];
  if (onlyMaker) {
    makers = [onlyMaker];
  } else {
    const users = await prisma.managedUser.findMany({
      orderBy: { updatedAt: "desc" },
    });
    for (const u of users) {
      if (!agentAddress) {
        makers.push(u.address);
        continue;
      }
      const registered = await isKeyRegistered(u.address, agentAddress);
      if (registered === false) {
        await prisma.managedUser.deleteMany({ where: { address: u.address } });
        pruned.push(u.address);
        continue;
      }
      makers.push(u.address);
    }
  }
  if (makers.length === 0) {
    return Response.json({
      decisions: [],
      pruned,
      note: "no makers (delegate first or pass ?maker=)",
    });
  }

  const decisions: Decision[] = [];
  const errors: string[] = [];
  for (const maker of makers) {
    try {
      decisions.push(...(await evaluateMaker(maker, apiKey)));
    } catch (e: any) {
      errors.push(`${maker}: ${e?.message}`);
    }
  }

  for (const d of decisions) {
    try {
      await prisma.agentDecision.create({
        data: {
          maker: d.maker.toLowerCase(),
          chainId: d.chainId,
          strategyHash: d.strategyHash,
          pair: d.pair,
          action: d.action,
          reason: d.reason,
          volume24h: d.volume24h,
          apy: d.apy,
        },
      });
    } catch (e) {
      console.warn("[agent-tick] decision log failed:", (e as Error)?.message);
    }
  }

  const summary = {
    makers: makers.length,
    dock: decisions.filter((d) => d.action === "dock").length,
    watch: decisions.filter((d) => d.action === "watch").length,
    reviewFee: decisions.filter((d) => d.action === "review-fee").length,
    keep: decisions.filter((d) => d.action === "keep").length,
  };
  console.log(`[agent-tick] ${JSON.stringify(summary)}`);
  for (const d of decisions.filter((d) => d.action !== "keep")) {
    console.log(
      `[agent-tick] ${d.action.toUpperCase()} ${d.pair} ${d.strategyHash.slice(0, 10)} - ${d.reason}`,
    );
  }
  return Response.json({ summary, decisions, errors, pruned, dryRun: true });
}
