import { createPublicClient, http, type Address, type Hex } from "viem";
import { base } from "viem/chains";

export type Verdict =
  | "healthy"
  | "depleted"
  | "side-depleted"
  | "oor-suspect"
  | "thin-allowance"
  | "unreadable";

export type TrashReason =
  | "demo-force"
  | "demo-all"
  | "zero-volume-both-windows"
  | "low-volume-24h"
  | "low-apy"
  | "underperforming-vs-top"
  | "low-volume-vs-size"
  | "low-fee-vs-size"
  | null;

export interface TrashThresholds {
  trashMinVolumeUsd: number;
  trashMaxApyPct: number | null;
  trashZeroVolumeBothWindows: boolean;
  demoForceTrashHashes: string[];
  demoTrashAllAggressive: boolean;
  /** Hours after deploy during which volume/APY trash is skipped (fresh positions need time). Demo overrides bypass it. */
  trashGraceHours: number;
  /** Trash when position APY < topApy * factor (relative underperformance). Null disables. */
  trashApyVsTopFactor: number | null;
  /** Trash when 24h volume < sizeUsd * factor (capital efficiency). Null disables. */
  trashMinVolumeRatio: number | null;
  /** Trash when total fees < sizeUsd * factor. Null disables. */
  trashMinFeeRatio: number | null;
  /** Minimum position age in hours before efficiency rules apply. */
  trashEffMinAgeHours: number;
}

export const DEFAULT_TRASH: TrashThresholds = {
  trashMinVolumeUsd: 1.0,
  trashMaxApyPct: null,
  trashZeroVolumeBothWindows: true,
  demoForceTrashHashes: [],
  demoTrashAllAggressive: false,
  trashGraceHours: 6,
  trashApyVsTopFactor: 0.1,
  trashMinVolumeRatio: 0.05,
  trashMinFeeRatio: 0.001,
  trashEffMinAgeHours: 6,
};

export function decideVerdict(args: {
  balA: bigint;
  balB: bigint;
  sideDepleted: boolean;
  quoteOk: boolean;
  allowanceOk: boolean;
  infraDegraded: boolean;
}): Verdict {
  const { balA, balB, sideDepleted, quoteOk, allowanceOk, infraDegraded } =
    args;
  if (infraDegraded) return "unreadable";
  if (balA < 0n || balB < 0n) return "unreadable";
  if (balA === 0n && balB === 0n) return "depleted";
  if (sideDepleted) return "side-depleted";
  if (!quoteOk) return "oor-suspect";
  if (!allowanceOk) return "thin-allowance";
  return "healthy";
}

export function isSideDepleted(
  tokens: Array<{ initialRaw?: string; currentRaw?: string }>,
): boolean {
  return tokens.some((t) => {
    if (!t.initialRaw || t.currentRaw === undefined) return false;
    try {
      return BigInt(t.initialRaw) > 0n && BigInt(t.currentRaw) === 0n;
    } catch {
      return false;
    }
  });
}

export function ageHoursSince(createdAt: string | Date | null | undefined): number | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 3600000;
}

export function decideTrash(args: {
  strategyHash: string;
  volume24h: number | null;
  volume7d: number | null;
  apy: number | null;
  feesTotalUsd: number | null;
  sizeUsd: number | null;
  ageHours: number | null;
  topApy: number | null;
  thresholds: TrashThresholds;
}): { trash: boolean; reason: TrashReason } {
  const { strategyHash, volume24h, volume7d, apy, feesTotalUsd, sizeUsd, ageHours, topApy, thresholds } = args;
  const hash = strategyHash.toLowerCase();
  if (
    thresholds.demoForceTrashHashes.some((h) => h.toLowerCase() === hash)
  ) {
    return { trash: true, reason: "demo-force" };
  }
  if (thresholds.demoTrashAllAggressive) {
    return { trash: true, reason: "demo-all" };
  }
  if (
    ageHours !== null &&
    ageHours < thresholds.trashGraceHours
  ) {
    return { trash: false, reason: null };
  }
  if (
    thresholds.trashZeroVolumeBothWindows &&
    volume24h !== null &&
    volume7d !== null &&
    volume24h === 0 &&
    volume7d === 0
  ) {
    return { trash: true, reason: "zero-volume-both-windows" };
  }
  if (volume24h !== null && volume24h < thresholds.trashMinVolumeUsd) {
    return { trash: true, reason: "low-volume-24h" };
  }
  if (
    thresholds.trashMaxApyPct !== null &&
    apy !== null &&
    apy < thresholds.trashMaxApyPct
  ) {
    return { trash: true, reason: "low-apy" };
  }
  if (
    thresholds.trashApyVsTopFactor !== null &&
    topApy !== null &&
    topApy > 0 &&
    (apy ?? 0) < topApy * thresholds.trashApyVsTopFactor
  ) {
    return { trash: true, reason: "underperforming-vs-top" };
  }
  // Capital efficiency: an in-range position that earns nothing relative to
  // its size ties up funds. Gated by minimum age so fresh positions get time.
  const effAgeOk =
    ageHours !== null && ageHours >= thresholds.trashEffMinAgeHours;
  if (effAgeOk && sizeUsd !== null && sizeUsd > 0) {
    if (
      thresholds.trashMinVolumeRatio !== null &&
      volume24h !== null &&
      volume24h < sizeUsd * thresholds.trashMinVolumeRatio
    ) {
      return { trash: true, reason: "low-volume-vs-size" };
    }
    if (
      thresholds.trashMinFeeRatio !== null &&
      feesTotalUsd !== null &&
      feesTotalUsd < sizeUsd * thresholds.trashMinFeeRatio
    ) {
      return { trash: true, reason: "low-fee-vs-size" };
    }
  }
  return { trash: false, reason: null };
}

export function isRotationCandidate(
  verdict: Verdict,
  trash: boolean,
): boolean {
  return (
    verdict === "oor-suspect" ||
    verdict === "depleted" ||
    verdict === "side-depleted" ||
    trash
  );
}

export interface RotationSignal {
  eligible: boolean;
  headline: string;
  reasons: string[];
  verdict: Verdict;
  trash: boolean;
  trashReason: TrashReason;
}

const TRASH_TEXT: Record<Exclude<TrashReason, null>, string> = {
  "demo-force": "flagged for rotation demo",
  "demo-all": "demo mode: all managed positions rotate",
  "zero-volume-both-windows": "zero volume in 24h and 7d",
  "low-volume-24h": "24h volume below trash threshold",
  "low-apy": "APY below trash threshold",
  "underperforming-vs-top": "APY far below top earners",
  "low-volume-vs-size": "24h volume too small for position size",
  "low-fee-vs-size": "fees earned too small for position size",
};

/**
 * Shared eligibility indicator: one function used by the dashboard card
 * (via /api/rotation/signal) and the rotator cron, so both always agree on
 * whether a position deserves rotation.
 */
export function describeEligibility(args: {
  verdict: Verdict;
  trash: boolean;
  trashReason: TrashReason;
  gainUsd: number;
  gasUsd: number;
  minBps: number;
  aiLevel?: string | null;
  aiEnforced?: boolean;
}): RotationSignal {
  const { verdict, trash, trashReason, gainUsd, gasUsd, minBps } = args;
  const aiEnforced = args.aiEnforced ?? false;
  const aiLevel = args.aiLevel ?? null;
  const reasons: string[] = [];

  if (verdict === "healthy") reasons.push("In range and fillable");
  if (verdict === "depleted") reasons.push("Empty — capital sits idle");
  if (verdict === "side-depleted") reasons.push("One side drained to zero");
  if (verdict === "oor-suspect") reasons.push("Out of range — quote reverted");
  if (verdict === "thin-allowance")
    reasons.push("Fillable, but Aqua allowance too low");
  if (verdict === "unreadable") reasons.push("Chain reads failed — cannot judge");
  if (trash && trashReason) reasons.push(`Trash: ${TRASH_TEXT[trashReason]}`);

  const candidate = isRotationCandidate(verdict, trash);
  if (!candidate) {
    return {
      eligible: false,
      headline: "Healthy — compounding in place",
      reasons,
      verdict,
      trash,
      trashReason,
    };
  }
  // Dead capital (OOR, empty, or drained) rotates to free the funds, not to
  // chase gain: quoting an OOR position yields ~zero by definition, so the
  // gain gate would pin it at amber forever. Gain gate applies only to
  // positions that still earn (healthy / thin-allowance trash).
  const deadCapital =
    verdict === "oor-suspect" ||
    verdict === "depleted" ||
    verdict === "side-depleted";
  if (!deadCapital) {
    const { pass: gainPass, bps } = passesGainGate(gainUsd, gasUsd, minBps);
    if (!gainPass) {
      reasons.push(
        `Expected gain $${gainUsd.toFixed(2)} below ${minBps / 10000}x gas $${gasUsd.toFixed(2)} (bps=${bps})`,
      );
      return {
        eligible: false,
        headline: "Not ideal — gain too small to rotate",
        reasons,
        verdict,
        trash,
        trashReason,
      };
    }
  } else {
    reasons.push("Dead capital — rotation frees the funds");
  }
  // AI advises only on judgment calls (healthy/trash positions). Dead capital
  // is proven deterministically (price band, empty balances), so a flaky or
  // silent AI service must not veto its rotation.
  const needsAi = aiEnforced && !deadCapital;
  if (needsAi && aiLevel !== "HIGH") {
    reasons.push(
      aiLevel === null ? "AI review pending (cron)" : `AI rated ${aiLevel}, needs HIGH`,
    );
    return {
      eligible: false,
      headline: "Not ideal — awaiting AI review",
      reasons,
      verdict,
      trash,
      trashReason,
    };
  }
  if (aiEnforced && !needsAi && aiLevel !== null && aiLevel !== "HIGH") {
    reasons.push(`AI rated ${aiLevel} (advisory only for dead capital)`);
  }
  reasons.push(
    deadCapital
      ? "Passes verdict and trash gates (gain/AI bypassed: dead capital)"
      : "Passes verdict, trash, gain and AI gates",
  );
  return {
    eligible: true,
    headline: "Not ideal — better to rotate",
    reasons,
    verdict,
    trash,
    trashReason,
  };
}

export interface RateToken {
  address?: string;
  currentBalance?: { raw?: string; usd?: number | null } | string;
}

/** USD value of one raw unit, derived from a token's reported balance. Null when unknown. */
export function usdPerRaw(tokens: RateToken[], token: string): number | null {
  const t = tokens.find(
    (x) => String(x.address ?? "").toLowerCase() === token.toLowerCase(),
  );
  const bal = t?.currentBalance;
  const rawStr = typeof bal === "string" ? bal : bal?.raw;
  const usd = typeof bal === "object" && bal !== null ? bal.usd : null;
  if (!rawStr || typeof usd !== "number" || !Number.isFinite(usd)) return null;
  try {
    if (BigInt(rawStr) === 0n || usd <= 0) return null;
    return usd / Number(BigInt(rawStr));
  } catch {
    return null;
  }
}

/** Estimated rotation gain in USD from a quote, using the output token's rate. Zero when unknown. */
export function estimateGainUsd(
  quotedOut: bigint,
  outRate: number | null,
  estGainBps: number,
): number {
  if (outRate === null || outRate <= 0 || quotedOut <= 0n) return 0;
  return Number(quotedOut) * outRate * (estGainBps / 10000);
}

export interface PriceCheckToken {
  address?: string;
  decimals?: number;
  currentBalance?: { raw?: string; usd?: number | null } | string;
}

/**
 * True price-OOR check: compares live spot (from token USD rates) against the
 * position's stored raw band. Quote probes alone cannot prove OOR because a
 * single-sided position can still fill in one direction while earning nothing.
 * Returns null when inputs are missing (caller falls back to quote verdict).
 */
export function isPriceOutOfRange(args: {
  tokenA: string;
  tokenB: string;
  decA?: number;
  decB?: number;
  priceMin?: string | null;
  priceMax?: string | null;
  tokens: PriceCheckToken[];
}): boolean | null {
  const { tokenA, tokenB, decA, decB, priceMin, priceMax, tokens } = args;
  if (
    decA === undefined ||
    decB === undefined ||
    !priceMin ||
    !priceMax ||
    !Number.isFinite(decA) ||
    !Number.isFinite(decB)
  ) {
    return null;
  }
  const rateA = usdPerRaw(tokens, tokenA);
  const rateB = usdPerRaw(tokens, tokenB);
  if (rateA === null || rateB === null || rateA <= 0 || rateB <= 0) return null;
  let min: bigint;
  let max: bigint;
  try {
    min = BigInt(priceMin);
    max = BigInt(priceMax);
    if (min <= 0n || max <= min) return null;
  } catch {
    return null;
  }
  // Same convention as the deploy allocator's rangeAroundSpot.
  const pA = rateA * 10 ** decA;
  const pB = rateB * 10 ** decB;
  if (!(pA > 0) || !(pB > 0)) return null;
  const aPerB = 1 / pA / (1 / pB);
  const hiIsA = tokenA.toLowerCase() > tokenB.toLowerCase();
  const h = hiIsA ? aPerB : 1 / aPerB;
  if (!(h > 0) || !Number.isFinite(h)) return null;
  const decHi = hiIsA ? decA : decB;
  const decLo = hiIsA ? decB : decA;
  const spot = BigInt(Math.floor(h * 1e18 * 10 ** (decHi - decLo)));
  // 0.5% tolerance so float noise near the edge never flaps the badge.
  if (spot * 1000n < min * 995n) return true;
  if (spot * 1000n > max * 1005n) return true;
  return false;
}

/** Scaled-integer gain gate: pass when gain/gas * 10000 >= minBps (20000 = 2x). */
export function passesGainGate(
  gainUsd: number,
  gasUsd: number,
  minBps: number,
): { pass: boolean; bps: number } {
  if (!(gasUsd > 0) || !(gainUsd > 0)) return { pass: false, bps: 0 };
  const bps = Math.floor((gainUsd / gasUsd) * 10000);
  return { pass: bps >= minBps, bps };
}

const AI_PROMPT = `You classify Aqua liquidity position rotation urgency. Input lines look like: <strategyHash> <pair> <verdict> balA=<raw> balB=<raw> trash=<true|false>. Verdict meanings: healthy=in range and fillable; depleted=both balances zero; side-depleted=one side drained to zero; oor-suspect=out of range, quote reverted; thin-allowance=fillable but Aqua allowance too low; unreadable=chain read failed. Decide level by these rules in order: unreadable=>LOW; depleted=>HIGH; side-depleted=>HIGH; oor-suspect=>HIGH; trash=true=>HIGH; thin-allowance=>MEDIUM; healthy=>LOW. Reply ONLY a JSON array, no other text: [{"hash":"<full 66-char strategyHash exactly as in input>","level":"LOW|MEDIUM|HIGH"}]. Copy each hash exactly, never truncate. Reply with minified single-line JSON: no markdown fences, no spaces, no newlines.`;

export function buildAiPrompt(lines: string[]): string {
  return `${AI_PROMPT}\n${lines.join("\n")}`;
}

function cleanAiText(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function extractAiContent(raw: string): string {
  const scrubbed = raw
    .replace(/data:\s*\[DONE\]/gi, "")
    .replace(/^event:.*$/gim, "")
    .trim();
  try {
    const j = JSON.parse(scrubbed) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    };
    const c = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text;
    if (typeof c === "string" && c) return cleanAiText(c);
  } catch {
    // fall through to line parser below
  }
  for (const line of scrubbed.split("\n")) {
    const m = line.match(/([0-9a-fx]{8,66})\s*:?\s*(LOW|MEDIUM|HIGH)/i);
    if (m) return `${m[1]}:${m[2].toUpperCase()}`;
  }
  return "";
}

/** Single AI call over all positions. Returns map hash(lower) -> level. Never throws. */
export async function classifyPositions(args: {
  aiApiUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiMaxTokens: number;
  lines: string[];
  knownHashes: string[];
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (args.lines.length === 0) return out;
  const hashSet = new Set(args.knownHashes.map((h) => h.toLowerCase()));
  for (let attempt = 0; attempt < 2 && out.size === 0; attempt++) {
    try {
      const res = await fetch(args.aiApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${args.aiApiKey}`,
        },
        body: JSON.stringify({
          model: args.aiModel,
          max_tokens: args.aiMaxTokens,
          reasoning: { exclude: true },
          messages: [{ role: "user", content: buildAiPrompt(args.lines) }],
        }),
      });
      const text = await res.text();
      const content = extractAiContent(text);
      if (!content) continue;
      try {
        const arr = JSON.parse(content) as unknown;
        if (Array.isArray(arr)) {
          for (const e of arr) {
            const h = String(
              (e as { hash?: string })?.hash ?? "",
            ).toLowerCase();
            const lv = String(
              (e as { level?: string })?.level ?? "",
            ).toUpperCase();
            if (!h || (lv !== "LOW" && lv !== "MEDIUM" && lv !== "HIGH"))
              continue;
            if (hashSet.has(h)) {
              out.set(h, lv);
              continue;
            }
            if (/^0x[0-9a-f]{8}$/.test(h)) {
              const hit = args.knownHashes.find((x) =>
                x.toLowerCase().startsWith(h),
              );
              if (hit) out.set(hit.toLowerCase(), lv);
            }
          }
        }
      } catch {
        // line-parser single hit already handled above; ignore
      }
    } catch {
      // transient: retry once, else empty map
    }
  }
  return out;
}

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11" as Address;

const MULTICALL_ABI = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const RAW_BALANCES_ABI = [
  {
    name: "rawBalances",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "balance", type: "uint248" }, { name: "tokensCount", type: "uint8" }],
  },
] as const;

const ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "allowance", type: "uint256" }],
  },
] as const;

const BALANCEOF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

const QUOTE_ABI = [
  {
    name: "quote",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOut", type: "uint256" }, { name: "orderHash", type: "bytes32" }],
  },
] as const;

export function rotatorPublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

export type RotatorClients = ReturnType<typeof rotatorPublicClient>;

export {
  MULTICALL3,
  MULTICALL_ABI,
  RAW_BALANCES_ABI,
  ALLOWANCE_ABI,
  BALANCEOF_ABI,
  QUOTE_ABI,
};

export type { Address, Hex };
