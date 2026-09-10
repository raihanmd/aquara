import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeAbiParameters,
  decodeFunctionResult,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { AQUA, AQUA_ROUTER } from "@/lib/config";
import { fetchMakerPositions, fetchTopPositions, getApiKey } from "@/lib/aqua-api";
import {
  ageHoursSince,
  decideVerdict,
  decideTrash,
  describeEligibility,
  estimateGainUsd,
  isPriceOutOfRange,
  isSideDepleted,
  usdPerRaw,
  DEFAULT_TRASH,
  MULTICALL_ABI,
  MULTICALL3,
  RAW_BALANCES_ABI,
  ALLOWANCE_ABI,
  QUOTE_ABI,
} from "@/lib/rotation";

export const dynamic = "force-dynamic";

let topApyCache: number | null = null;
let topApyCachedAt = 0;

// Trash thresholds resolve from server env so demos can tune without code
// changes. Unset/invalid values fall back to DEFAULT_TRASH. Rotator uses the
// same values automatically because it consumes this route.
function resolveThresholds(): typeof DEFAULT_TRASH {
  const num = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const ratioOrNull = (name: string, fallback: number | null): number | null => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    if (raw.toLowerCase() === "null" || raw === "off") return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return v.toLowerCase() === "true";
  };
  return {
    trashMinVolumeUsd: num("TRASH_MIN_VOLUME_USD", DEFAULT_TRASH.trashMinVolumeUsd),
    trashMaxApyPct: ratioOrNull("TRASH_MAX_APY_PCT", DEFAULT_TRASH.trashMaxApyPct),
    trashZeroVolumeBothWindows: bool("TRASH_ZERO_VOLUME_BOTH", DEFAULT_TRASH.trashZeroVolumeBothWindows),
    demoForceTrashHashes: (process.env.TRASH_FORCE_HASHES || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[a-f0-9]{64}$/.test(s)),
    demoTrashAllAggressive: bool("TRASH_ALL", false),
    trashGraceHours: num("TRASH_GRACE_HOURS", DEFAULT_TRASH.trashGraceHours),
    trashApyVsTopFactor: ratioOrNull("TRASH_APY_VS_TOP", DEFAULT_TRASH.trashApyVsTopFactor),
    trashMinVolumeRatio: ratioOrNull("TRASH_MIN_VOLUME_RATIO", DEFAULT_TRASH.trashMinVolumeRatio),
    trashMinFeeRatio: ratioOrNull("TRASH_MIN_FEE_RATIO", DEFAULT_TRASH.trashMinFeeRatio),
    trashEffMinAgeHours: num("TRASH_EFF_MIN_AGE_H", DEFAULT_TRASH.trashEffMinAgeHours),
  };
}

const TAKER_TRAITS_DEFAULT =
  "0x00000000000000000000000000000000000000000041" as Hex;

function rawOf(v: { raw?: string } | string | undefined): string | undefined {
  if (typeof v === "string") return v;
  return v?.raw;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const maker = searchParams.get("maker");
  if (!maker || !/^0x[a-fA-F0-9]{40}$/.test(maker)) {
    return Response.json({ error: "maker required" }, { status: 400 });
  }
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.base.org";
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const rows = await prisma.managedStrategy.findMany({
    where: { maker: maker.toLowerCase() },
  });
  const dbRows = new Map(rows.map((r) => [r.strategyHash.toLowerCase(), r]));
  if (dbRows.size === 0) {
    return Response.json({ signals: [] });
  }

  const apiKey = process.env.ONEINCH_API_KEY || "";
  const liveItems = apiKey
    ? await fetchMakerPositions(maker, apiKey, 20).catch(() => [])
    : [];
  const items: Array<{
    strategyHash?: string;
    strategy?: string;
    openedAt?: number;
    tokens?: Array<{ address?: string; symbol?: string; decimals?: number; meta?: { decimals?: number; symbol?: string }; currentBalance?: { raw?: string; usd?: number | null } | string; initialBalance?: { raw?: string; usd?: number | null } | string }>;
    performance?: {
      volume?: { last24h?: { usd?: number }; last7d?: { usd?: number } };
      fees?: { last24h?: { apy?: number; usd?: number | null }; last7d?: { apy?: number; usd?: number | null }; total?: { apy?: number; usd?: number | null } };
    } | null;
  }> = liveItems as typeof items;

  // Benchmark: best APY across top earners. Positions earning a fraction
  // of it are flagged underperforming. Best-effort: null disables the check.
  // Cached module-level: the underlying fan-out (leaderboard + per-maker
  // strategies + overviews) is dozens of upstream calls, and this route runs
  // on every dashboard load. 10-minute TTL keeps it to ~6 upstream bursts/hr.
  const now = Date.now();
  if (now - topApyCachedAt > 10 * 60 * 1000) {
    topApyCache = null;
    try {
      const tops = await fetchTopPositions([8453], 5, "apy", getApiKey());
      for (const t of tops) {
        const a =
          numOrNull(t.performance?.fees?.last24h?.apy) ??
          numOrNull(t.performance?.fees?.last7d?.apy) ??
          numOrNull(t.performance?.fees?.last30d?.apy);
        if (a !== null && (topApyCache === null || a > topApyCache)) topApyCache = a;
      }
    } catch {
      topApyCache = null;
    }
    topApyCachedAt = now;
  }
  const topApy = topApyCache;

  const thresholds = resolveThresholds();
  const signals = [];
  for (const p of items) {
    const hash = String(p?.strategyHash ?? "");
    if (!hash) continue;
    const row = dbRows.get(hash.toLowerCase());
    const mode = "aggressive";
    const toks = (p.tokens ?? []).slice(0, 2);
    if (toks.length < 2) continue;
    const [tA, tB] = toks.map((t) => String(t.address ?? "").toLowerCase());

    let balA = -1n;
    let balB = -1n;
    let allowanceOk = false;
    try {
      const data = encodeFunctionData({
        abi: MULTICALL_ABI,
        functionName: "aggregate3",
        args: [[
          { target: AQUA as Address, allowFailure: true, callData: encodeFunctionData({ abi: RAW_BALANCES_ABI, functionName: "rawBalances", args: [maker as Address, AQUA_ROUTER as Address, hash as Hex, tA as Address] }) },
          { target: AQUA as Address, allowFailure: true, callData: encodeFunctionData({ abi: RAW_BALANCES_ABI, functionName: "rawBalances", args: [maker as Address, AQUA_ROUTER as Address, hash as Hex, tB as Address] }) },
          { target: tA as Address, allowFailure: true, callData: encodeFunctionData({ abi: ALLOWANCE_ABI, functionName: "allowance", args: [maker as Address, AQUA as Address] }) },
          { target: tB as Address, allowFailure: true, callData: encodeFunctionData({ abi: ALLOWANCE_ABI, functionName: "allowance", args: [maker as Address, AQUA as Address] }) },
        ]],
      });
      const raw = (await client.call({ to: MULTICALL3, data })) as unknown as { data?: Hex };
      if (raw?.data) {
        const rets = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: raw.data }) as unknown as Array<{ success: boolean; returnData: Hex }>;
        if (rets?.[0]?.success) {
          const [b] = decodeFunctionResult({ abi: RAW_BALANCES_ABI, functionName: "rawBalances", data: rets[0].returnData }) as unknown as [bigint, number];
          balA = b;
        }
        if (rets?.[1]?.success) {
          const [b] = decodeFunctionResult({ abi: RAW_BALANCES_ABI, functionName: "rawBalances", data: rets[1].returnData }) as unknown as [bigint, number];
          balB = b;
        }
        if (rets?.[2]?.success && rets?.[3]?.success) {
          const alA = decodeFunctionResult({ abi: ALLOWANCE_ABI, functionName: "allowance", data: rets[2].returnData }) as unknown as bigint;
          const alB = decodeFunctionResult({ abi: ALLOWANCE_ABI, functionName: "allowance", data: rets[3].returnData }) as unknown as bigint;
          allowanceOk = alA > 0n && alB > 0n;
        }
      }
    } catch {
      // balances stay -1n -> unreadable
    }

    // Quotes are directional: one side can revert while the other fills.
    // Try the funded side first, then the reverse. Only both failing means OOR.
    let quoteOk = false;
    let quotedOut = 0n;
    let quotedTokenOut = "";
    const strategyBytes = row?.strategyBytes;
    if (balA >= 0n && balB >= 0n && (balA > 0n || balB > 0n) && strategyBytes) {
      try {
        const [decoded] = decodeAbiParameters(
          [{ type: "tuple", components: [{ type: "address", name: "maker" }, { type: "uint256", name: "traits" }, { type: "bytes", name: "data" }] }],
          strategyBytes as Hex,
        ) as unknown as [{ maker: Address; traits: bigint; data: Hex }];
        const dirs: Array<[string, string]> =
          balA > 0n && balB > 0n ? [[tA, tB], [tB, tA]] : balA > 0n ? [[tA, tB]] : [[tB, tA]];
        for (const [tin, tout] of dirs) {
          try {
            const data = encodeFunctionData({
              abi: QUOTE_ABI,
              functionName: "quote",
              args: [
                { maker: decoded.maker, traits: decoded.traits, data: decoded.data },
                tin as Address,
                tout as Address,
                100000n,
                TAKER_TRAITS_DEFAULT,
              ],
            });
            const out = (await client.call({ to: AQUA_ROUTER as Address, data })) as unknown as { data?: Hex };
            if (out?.data) {
              const [, amountOut] = decodeFunctionResult({ abi: QUOTE_ABI, functionName: "quote", data: out.data }) as unknown as [bigint, bigint, Hex];
              quoteOk = true;
              quotedOut = amountOut;
              quotedTokenOut = tout;
              break;
            }
          } catch {
            // try the other direction
          }
        }
      } catch {
        quoteOk = false;
      }
    }

    const perf = (p.performance ?? null) as {
      volume?: { last24h?: { usd?: number }; last7d?: { usd?: number } };
      fees?: { last24h?: { apy?: number; usd?: number | null }; last7d?: { apy?: number; usd?: number | null }; total?: { apy?: number; usd?: number | null } };
    } | null;
    const v24 = numOrNull(perf?.volume?.last24h?.usd);
    const v7 = numOrNull(perf?.volume?.last7d?.usd);
    const apy =
      numOrNull(perf?.fees?.last24h?.apy) ??
      numOrNull(perf?.fees?.last7d?.apy) ??
      numOrNull(perf?.fees?.total?.apy);
    let verdict = decideVerdict({
      balA,
      balB,
      sideDepleted: isSideDepleted(
        toks.map((t) => ({ initialRaw: rawOf(t.initialBalance), currentRaw: rawOf(t.currentBalance) })),
      ),
      quoteOk,
      allowanceOk,
      infraDegraded: balA < 0n || balB < 0n,
    });
    // Price truth overrides quote probes: a band fully off-spot earns nothing
    // even when one fill direction still quotes.
    const decOf = (t: { decimals?: number; meta?: { decimals?: number } }): number | undefined => {
      const d = t.decimals ?? t.meta?.decimals;
      return typeof d === "number" && Number.isFinite(d) ? d : undefined;
    };
    const priceOor = isPriceOutOfRange({
      tokenA: tA,
      tokenB: tB,
      decA: decOf(toks[0]),
      decB: decOf(toks[1]),
      priceMin: (row as { priceMin?: string | null } | undefined)?.priceMin,
      priceMax: (row as { priceMax?: string | null } | undefined)?.priceMax,
      tokens: toks,
    });
    if (priceOor === true) verdict = "oor-suspect";
    // Age prefers live openedAt (unix seconds); DB createdAt is the fallback.
    const openedAtSec = typeof p.openedAt === "number" ? p.openedAt : null;
    const ageHours =
      openedAtSec !== null
        ? (Date.now() / 1000 - openedAtSec) / 3600
        : ageHoursSince((row as { createdAt?: string | Date } | undefined)?.createdAt);
    const tokUsd = (t: { currentBalance?: { usd?: number | null } | string }): number | null => {
      const b = t.currentBalance;
      const u = typeof b === "object" && b !== null ? b.usd : null;
      return typeof u === "number" && Number.isFinite(u) ? u : null;
    };
    const sizes = toks.map(tokUsd);
    const sizeUsd = sizes.every((s): s is number => s !== null)
      ? sizes.reduce((a, b) => a + b, 0)
      : null;
    const feesTotalUsd = numOrNull(perf?.fees?.total?.usd);
    const { trash, reason: trashReason } = decideTrash({
      strategyHash: hash,
      volume24h: v24,
      volume7d: v7,
      apy,
      feesTotalUsd,
      sizeUsd,
      ageHours,
      topApy,
      thresholds,
    });
    const gainUsd = estimateGainUsd(
      quotedOut,
      quoteOk ? usdPerRaw(p.tokens ?? [], quotedTokenOut) : null,
      50,
    );
    const signal = describeEligibility({
      verdict,
      trash,
      trashReason,
      gainUsd,
      gasUsd: 0.08,
      minBps: 20000,
      aiEnforced: false,
    });
    const symOf = (t: { symbol?: string; meta?: { symbol?: string }; address?: string }): string =>
      t.symbol || t.meta?.symbol || String(t.address ?? "").slice(0, 6);
    const symbols: [string, string] = [symOf(toks[0]), symOf(toks[1])];
    signals.push({
      strategyHash: hash,
      ...signal,
      mode,
      pair: `${symbols[0]}/${symbols[1]}`,
      symbols,
      tokenA: tA,
      tokenB: tB,
      balA: balA.toString(),
      balB: balB.toString(),
      quotedOut: quotedOut.toString(),
      gainUsd,
    });
  }
  return Response.json({ signals });
}
