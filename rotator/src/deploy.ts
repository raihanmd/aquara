import { createPublicClient, http, formatUnits, encodeFunctionData, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { agentSignAndSubmit } from "../../web/lib/calibur-agent.ts";
import type { RotatorConfig } from "./config.ts";
import type { Candidate } from "./evaluate.ts";

export const ERC20_MIN = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "allowance", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const V6_ROUTER = "0x111111125421ca6dc452d289314280a0f8842a65" as Address;
const MAX_UINT = 2n ** 256n - 1n;

export interface DeployResult {
  ok: boolean;
  jobId?: string;
  reason: string;
}

export async function tokenPriceUsd(oneinchKey: string, token: string): Promise<number | null> {
  if (!oneinchKey) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const res = await fetch(`https://api.1inch.com/price/v1.1/8453/${token}?currency=USD`, {
        headers: { Authorization: `Bearer ${oneinchKey}` },
      });
      if (res.status === 502 || res.status === 503 || res.status === 429) continue;
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, unknown>;
      const v = json[token] ?? json[token.toLowerCase()];
      return typeof v === "number" && v > 0 ? v : Number(v) > 0 ? Number(v) : null;
    } catch {
      // transient network error, retry
    }
  }
  return null;
}

/**
 * Pick dock proceeds that the deploy pipeline can price. The allocator
 * budgets in USD, so unpriceable capital fails planning after the funds are
 * already docked. Returns null when neither side has a price: caller must
 * skip BEFORE docking.
 */
export async function pickPricedCapital(
  oneinchKey: string,
  tokenA: string,
  tokenB: string,
): Promise<string | null> {
  for (const t of [tokenA, tokenB]) {
    if (await tokenPriceUsd(oneinchKey, t) !== null) return t;
  }
  return null;
}

import { quoteSwapExact, quoteOnly, lastQuoteDiag, type QuoteSanity } from "../../web/lib/oneinch-quote.ts";

/** Price-implied sanity for one swap leg. Undefined when unpriceable (gate opens, quote still needs a route). */
async function legSanity(
  cfg: RotatorConfig,
  client: ReturnType<typeof clientFor>,
  src: string,
  dst: string,
): Promise<QuoteSanity | undefined> {
  try {
    const [[sDec, sUsd], [dDec, dUsd]] = await Promise.all(
      [src, dst].map(async (t) => {
        const [dec, px] = await Promise.all([
          client.readContract({ address: t as Address, abi: ERC20_MIN, functionName: "decimals" }).catch(() => null) as Promise<number | null>,
          tokenPriceUsd(cfg.oneinchKey, t),
        ]);
        return [dec, px] as [number | null, number | null];
      }),
    );
    if (sDec === null || dDec === null || sUsd === null || dUsd === null) return undefined;
    return { srcUsd: sUsd, dstUsd: dUsd, srcDec: sDec, dstDec: dDec };
  } catch {
    return undefined;
  }
}

export function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

const STABLES = [
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
];

export async function selectCapital(
  cfg: RotatorConfig,
  deployPairs: Array<{ tokenA: string; tokenB: string }>,
): Promise<string> {
  const pairToks = [...new Set(deployPairs.flatMap((p) => [p.tokenA.toLowerCase(), p.tokenB.toLowerCase()]))];
  const stable = STABLES.find((s) => pairToks.includes(s));
  if (stable) return stable;
  for (const t of pairToks) {
    if ((await pickPricedCapital(cfg.oneinchKey, t, t)) !== null) return t;
  }
  return deployPairs[0].tokenA;
}

/**
 * Allowance-free preflight: the /quote endpoint needs no approval, so route
 * existence is proven BEFORE the dock spends gas. Returns legs or an error.
 */
export async function preflightSwaps(
  cfg: RotatorConfig,
  funds: Array<{ token: string; amount: bigint }>,
  capital: string,
  from: string,
): Promise<{ ok: true; legs: Array<{ token: string; amount: bigint; out: bigint }> } | { ok: false; reason: string }> {
  const legs: Array<{ token: string; amount: bigint; out: bigint }> = [];
  const client = clientFor(cfg.rpcUrl);
  for (const f of funds) {
    if (f.token.toLowerCase() === capital.toLowerCase() || f.amount === 0n) continue;
    const sanity = await legSanity(cfg, client, f.token, capital);
    const q = await quoteOnly({ apiKey: cfg.oneinchKey, src: f.token, dst: capital, amount: f.amount, sanity });
    if (!q || q.dstAmount === 0n)
      return { ok: false, reason: `no swap route ${f.token.slice(0, 6)}->${capital.slice(0, 6)} (${f.amount} raw) [${lastQuoteDiag()}] - skipping before dock, no gas spent` };
    legs.push({ token: f.token, amount: f.amount, out: q.dstAmount });
  }
  return { ok: true, legs };
}

/**
 * One batched approve tx for every token missing V6 allowance. The /swap
 * endpoint refuses to quote without allowance, so approvals land BEFORE any
 * swap data is fetched. One-time per token, reusable forever.
 */
export async function ensureAllowances(
  cfg: RotatorConfig,
  maker: string,
  tokens: Array<{ token: string; amount: bigint }>,
): Promise<{ ok: boolean; reason: string }> {
  const client = clientFor(cfg.rpcUrl);
  const calls: Array<{ to: Address; value: bigint; data: Hex }> = [];
  for (const t of tokens) {
    const alw = (await client.readContract({
      address: t.token as Address, abi: ERC20_MIN, functionName: "allowance", args: [maker as Address, V6_ROUTER],
    }).catch(() => 0n)) as bigint;
    if (alw < t.amount) {
      calls.push({
        to: t.token as Address,
        value: 0n,
        data: encodeFunctionData({ abi: ERC20_MIN, functionName: "approve", args: [V6_ROUTER, MAX_UINT] }),
      });
    }
  }
  if (calls.length === 0) return { ok: true, reason: "allowances already set" };
  try {
    await agentSignAndSubmit(maker as Address, calls);
    return { ok: true, reason: `approved ${calls.length} token(s) for swaps` };
  } catch (e: unknown) {
    return { ok: false, reason: `approve tx failed: ${String((e as Error)?.message ?? e).slice(0, 150)}` };
  }
}

export async function tokenBalance(
  client: ReturnType<typeof clientFor>,
  token: string,
  maker: string,
): Promise<bigint> {
  return (await client.readContract({
    address: token as Address, abi: ERC20_MIN, functionName: "balanceOf", args: [maker as Address],
  })) as bigint;
}

/**
 * Merge every non-capital snapshot fund into capital BEFORE /deploy, so the
 * deploy call sees the same pure-capital wallet a user has after manual
 * swaps. Received amounts are MEASURED (wallet deltas per swap), never
 * quoted estimates, so the deploy budget cannot drift. A failed leg aborts
 * the group with funds safe in the wallet (already-merged legs stay merged).
 */
export async function mergeFundsToCapital(
  cfg: RotatorConfig,
  maker: string,
  funds: Array<{ token: string; amount: bigint }>,
  capital: string,
  slippage = 0.5,
): Promise<{ ok: true; swappedIn: bigint; detail: string } | { ok: false; reason: string }> {
  const client = clientFor(cfg.rpcUrl);
  const isCap = (t: string) => t.toLowerCase() === capital.toLowerCase();
  const capBase = await tokenBalance(client, capital, maker).catch(() => 0n);
  let swappedIn = 0n;
  const done: string[] = [];
  for (const f of funds) {
    if (isCap(f.token) || f.amount === 0n) continue;
    const wallet = await tokenBalance(client, f.token, maker).catch(() => 0n);
    const spend = f.amount < wallet ? f.amount : wallet;
    if (spend === 0n) continue;
    // Re-quote up to 3x: volatile routes go stale between quote and sim
    // (observed live on cbETH). Each retry fetches a fresh quote.
    let q: Awaited<ReturnType<typeof quoteSwapExact>> = null;
    let qTries = 0;
    for (; qTries < 3; qTries++) {
      if (qTries > 0) await new Promise((r) => setTimeout(r, 4000 * qTries));
      const sanity = await legSanity(cfg, client, f.token, capital);
      q = await quoteSwapExact({ apiKey: cfg.oneinchKey, src: f.token, dst: capital, amount: spend, from: maker, slippage, sanity });
      if (q && q.dstAmount > 0n) break;
    }
    if (!q || q.dstAmount === 0n)
      return { ok: false, reason: `no swap route ${f.token.slice(0, 6)}->${capital.slice(0, 6)} (${spend} raw) [${lastQuoteDiag()}] - merged so far stays in wallet` };
    const alw = (await client.readContract({
      address: f.token as Address, abi: ERC20_MIN, functionName: "allowance", args: [maker as Address, V6_ROUTER],
    }).catch(() => 0n)) as bigint;
    const approveCall: { to: Address; value: bigint; data: Hex } | null =
      alw < spend
        ? {
            to: f.token as Address,
            value: 0n,
            data: encodeFunctionData({ abi: ERC20_MIN, functionName: "approve", args: [V6_ROUTER, MAX_UINT] }),
          }
        : null;
    let swapCall = { to: q.to, value: q.value, data: q.data };
    // Per-leg sims name the failing call before any gas is spent (deploy
    // parity: deploy sims each leg solo for the same reason). One retry with
    // a fresh quote: sims fail on stale volatile routes, not just bad ones.
    const { simulateBatch } = await import("../../web/lib/calibur-agent.ts");
    if (approveCall) {
      const ae = await simulateBatch(maker as Address, [approveCall]);
      if (ae)
        return { ok: false, reason: `merge approve would revert ${f.token.slice(0, 6)} (${ae.slice(0, 100)}) - nothing sent, funds stay put` };
    }
    let se = await simulateBatch(maker as Address, [swapCall]);
    if (se) {
      await new Promise((r) => setTimeout(r, 4000));
      const sanity2 = await legSanity(cfg, client, f.token, capital);
      const q2 = await quoteSwapExact({ apiKey: cfg.oneinchKey, src: f.token, dst: capital, amount: spend, from: maker, slippage, sanity: sanity2 });
      if (q2 && q2.dstAmount > 0n) {
        swapCall = { to: q2.to, value: q2.value, data: q2.data };
        se = await simulateBatch(maker as Address, [swapCall]);
      }
    }
    if (se)
      return { ok: false, reason: `merge swap would revert ${f.token.slice(0, 6)}->${capital.slice(0, 6)} (${se.slice(0, 100)}) - nothing sent, funds stay put` };
    const calls: Array<{ to: Address; value: bigint; data: Hex }> = [...(approveCall ? [approveCall] : []), swapCall];
    try {
      await agentSignAndSubmit(maker as Address, calls);
    } catch (e: unknown) {
      return { ok: false, reason: `merge swap failed ${f.token.slice(0, 6)}->${capital.slice(0, 6)}: ${String((e as Error)?.message ?? e).slice(0, 120)} - merged so far stays in wallet` };
    }
    // Settle-poll the receipt: LB nodes serve pre-swap state for seconds,
    // and a stale zero here silently shrinks the deploy budget.
    let capNow = await tokenBalance(client, capital, maker).catch(() => capBase + swappedIn);
    for (let fr = 0; fr < 4; fr++) {
      await new Promise((r) => setTimeout(r, 3000));
      const n = await tokenBalance(client, capital, maker).catch(() => capNow);
      if (n === capNow) break;
      capNow = n;
    }
    const got = capNow > capBase + swappedIn ? capNow - (capBase + swappedIn) : 0n;
    swappedIn += got;
    // Per-leg receive check vs quote: flags short fills loudly. No abort
    // here by design - funds already moved, and deploying the measured
    // amount is always safer than stranding merged capital.
    const shortPct = q.dstAmount > 0n ? Number((q.dstAmount - got) * 10000n / q.dstAmount) / 100 : 0;
    done.push(`${f.token.slice(0, 6)}->${capital.slice(0, 6)} +${got} (quoted ${q.dstAmount}${shortPct > 2 ? ` SHORT ${shortPct.toFixed(1)}%` : ""})`);
  }
  return { ok: true, swappedIn, detail: done.join(", ") || "already pure capital" };
}

export async function postDeploy(
  cfg: RotatorConfig,
  c: Candidate,
  capital: string,
  capitalAmount: string,
  deployPairs: Array<{ tokenA: string; tokenB: string }>,
): Promise<DeployResult> {
  const res = await fetch(`${cfg.webBase}/api/agent/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-key": cfg.cronKey },
    body: JSON.stringify({
      maker: c.maker,
      capital,
      capitalAmount,
      pairs: deployPairs.map((p) => ({ tokenA: p.tokenA, tokenB: p.tokenB })),
      execution: "batched",
      mode: "aggressive",
      reason: `cron rotation of ${c.strategyHash.slice(0, 10)} (${c.verdict}, gain ${c.gainUsd.toFixed(2)}/${c.gasUsd})`,
    }),
  });
  if (res.status === 401 || res.status === 403 || res.status === 409) {
    return { ok: false, reason: `deploy refused ${res.status}` };
  }
  if (!res.ok || !res.body) return { ok: false, reason: `deploy http ${res.status}` };
  let jobId: string | undefined;
  let ok = 0;
  let total = 0;
  let err: string | undefined;
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          if (typeof ev.jobId === "string") jobId = ev.jobId;
          if (ev.done === true) {
            ok = typeof ev.ok === "number" ? ev.ok : 0;
            total = typeof ev.total === "number" ? ev.total : 0;
            if (typeof ev.error === "string") err = ev.error;
          }
        } catch {
          // keep-alive or partial frame, ignore
        }
      }
    }
  } catch (e: unknown) {
    return { ok: false, jobId, reason: `deploy stream broke: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  if (err) return { ok: false, jobId, reason: `deploy failed: ${err.slice(0, 200)}` };
  if (ok > 0) return { ok: true, jobId, reason: `deployed ${ok}/${total}${jobId ? ` job=${jobId}` : ""}` };
  return { ok: false, jobId, reason: `deploy yielded nothing (0/${total})` };
}
