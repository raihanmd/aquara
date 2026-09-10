import {
  describeEligibility,
  classifyPositions,
  type Verdict,
  type TrashReason,
} from "../../web/lib/rotation.ts";
import type { RotatorConfig } from "./config.ts";

interface SignalItem {
  strategyHash: string;
  eligible: boolean;
  headline: string;
  reasons: string[];
  verdict: Verdict;
  trash: boolean;
  trashReason: TrashReason;
  mode: string;
  pair: string;
  symbols?: [string, string];
  tokenA: string;
  tokenB: string;
  balA: string;
  balB: string;
  quotedOut: string;
  gainUsd: number;
}

export interface Candidate {
  maker: string;
  strategyHash: string;
  pair: string;
  symbols?: [string, string];
  mode: string;
  verdict: Verdict;
  trash: boolean;
  trashReason: TrashReason;
  aiLevel: string | null;
  gainUsd: number;
  gasUsd: number;
  tokenA: string;
  tokenB: string;
}

export interface EvalOutcome {
  hash: string;
  pair: string;
  verdict: Verdict;
  eligible: boolean;
  reasons: string[];
  aiLevel: string | null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

// Single source of truth: all chain reads, verdicts, trash and gain math live
// in web/app/api/rotation/signal (web/lib/rotation.ts). The rotator only adds
// the AI gate, daily caps and execution. Nothing is computed twice.
export async function evaluateMaker(
  cfg: RotatorConfig,
  maker: string,
): Promise<{ candidate: Candidate | null; reason: string; checked: number; outcomes: EvalOutcome[] }> {
  const [makers, stratBody] = await Promise.all([
    fetchMakers(cfg.webBase),
    getJson(`${cfg.webBase}/api/strategies?maker=${maker}`).catch(() => []),
  ]);
  const rows = (
    Array.isArray(stratBody) ? (stratBody as Array<{ strategyHash?: string }>) : []
  ).filter((r) => r?.strategyHash);
  if (!makers.some((m) => m.toLowerCase() === maker.toLowerCase())) {
    return { candidate: null, reason: "not delegated: maker not registered", checked: 0, outcomes: [] };
  }
  if (rows.length === 0) {
    return { candidate: null, reason: "kill-switch: no managed rows", checked: 0, outcomes: [] };
  }

  const sigBody = (await getJson(
    `${cfg.webBase}/api/rotation/signal?maker=${maker}`,
  ).catch(() => ({ signals: [] }))) as { signals?: SignalItem[] };
  const signals = (sigBody?.signals ?? []).filter((s) => s?.strategyHash);
  if (signals.length === 0) {
    return { candidate: null, reason: "no signals from web", checked: 0, outcomes: [] };
  }

  const aiLines = signals.map(
    (s) => `${s.strategyHash} ${s.pair} ${s.verdict} balA=${s.balA} balB=${s.balB} trash=${s.trash}`,
  );
  let aiNotes = new Map<string, string>();
  if (cfg.aiEnabled && cfg.aiKey && signals.length > 0) {
    aiNotes = await classifyPositions({
      aiApiUrl: cfg.aiUrl,
      aiApiKey: cfg.aiKey,
      aiModel: cfg.aiModel,
      aiMaxTokens: cfg.aiMaxTokens,
      lines: aiLines,
      knownHashes: signals.map((s) => s.strategyHash),
    });
  }

  const outcomes: EvalOutcome[] = [];
  for (const s of signals) {
    const aiLevel = aiNotes.get(s.strategyHash.toLowerCase()) ?? null;
    const signal = describeEligibility({
      verdict: s.verdict,
      trash: s.trash,
      trashReason: s.trashReason,
      gainUsd: typeof s.gainUsd === "number" ? s.gainUsd : 0,
      gasUsd: cfg.gasUsd,
      minBps: cfg.minGainBps,
      aiLevel,
      aiEnforced: cfg.aiEnabled && cfg.aiKey !== "",
    });
    outcomes.push({
      hash: s.strategyHash,
      pair: s.pair,
      verdict: s.verdict,
      eligible: signal.eligible,
      reasons: signal.reasons,
      aiLevel,
    });
    if (!signal.eligible) continue;
    return {
      candidate: {
        maker,
        strategyHash: s.strategyHash,
        pair: s.pair,
        symbols: s.symbols,
        mode: s.mode,
        verdict: s.verdict,
        trash: s.trash,
        trashReason: s.trashReason,
        aiLevel,
        gainUsd: typeof s.gainUsd === "number" ? s.gainUsd : 0,
        gasUsd: cfg.gasUsd,
        tokenA: s.tokenA,
        tokenB: s.tokenB,
      },
      reason: signal.reasons.join("; "),
      checked: signals.length,
      outcomes,
    };
  }
  return { candidate: null, reason: "no eligible candidate", checked: signals.length, outcomes };
}

export async function todayRotationCount(webBase: string, maker: string): Promise<number> {
  try {
    const rows = (await getJson(
      `${webBase}/api/agent/decisions?maker=${maker}&limit=100`,
    )) as Array<{ action?: string; reason?: string; createdAt?: string }>;
    const today = new Date().toISOString().slice(0, 10);
    return (Array.isArray(rows) ? rows : []).filter(
      (r) =>
        typeof r?.createdAt === "string" &&
        r.createdAt.slice(0, 10) === today &&
        typeof r?.reason === "string" &&
        r.reason.includes("cron rotation"),
    ).length;
  } catch {
    return 0;
  }
}

export async function fetchMakers(webBase: string): Promise<string[]> {
  try {
    const body = await getJson(`${webBase}/api/users?chainId=8453`);
    const list = (Array.isArray(body) ? body : []) as unknown[];
    return list.filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
}
