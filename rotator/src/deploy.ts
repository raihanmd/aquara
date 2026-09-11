import { createPublicClient, http, formatUnits, encodeFunctionData, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { agentSignAndSubmit } from "../../web/lib/calibur-agent.ts";
import type { RotatorConfig } from "./config.ts";
import type { Candidate } from "./evaluate.ts";

const ERC20_MIN = [
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

async function tokenPriceUsd(oneinchKey: string, token: string): Promise<number | null> {
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

async function swapQuote(
  oneinchKey: string,
  src: string,
  dst: string,
  amount: bigint,
  from: string,
): Promise<{ to: Address; data: Hex; value: bigint } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const qs = new URLSearchParams({ src, dst, amount: amount.toString(), from, slippage: "0.5" });
      const res = await fetch(`https://api.1inch.com/swap/v6.1/8453/swap?${qs}`, {
        headers: { Authorization: `Bearer ${oneinchKey}` },
      });
      if (res.status === 502 || res.status === 503 || res.status === 429) continue;
      if (!res.ok) return null;
      const json = (await res.json()) as { tx?: { to?: string; data?: string; value?: string } };
      if (!json?.tx?.to || !json?.tx?.data) return null;
      return { to: json.tx.to as Address, data: json.tx.data as Hex, value: BigInt(json.tx.value ?? 0) };
    } catch {
      // retry
    }
  }
  return null;
}

export function clientFor(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
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
 * Merge the minor proceeds side into the capital token so the redeploy ships
 * the full docked amount, not just one side. Skips dust (<= $0.005) where
 * swap gas exceeds the value. Uses the agent key (approve + swap batched in
 * one Calibur execute). Amounts are explicit dock deltas, never wallet reads.
 */
async function consolidateProceeds(
  cfg: RotatorConfig,
  maker: Address,
  capital: string,
  other: string,
  otherAmount: bigint,
  client: ReturnType<typeof clientFor>,
): Promise<{ consolidated: boolean; reason: string }> {
  if (otherAmount === 0n) return { consolidated: false, reason: "nothing to consolidate" };
  const [decO, priceO] = await Promise.all([
    client.readContract({ address: other as Address, abi: ERC20_MIN, functionName: "decimals" }) as Promise<number>,
    tokenPriceUsd(cfg.oneinchKey, other),
  ]);
  const usdO = priceO !== null ? (Number(otherAmount) / 10 ** decO) * priceO : null;
  if (usdO === null) return { consolidated: false, reason: "no USD price for minor side" };
  if (usdO <= 0.005) return { consolidated: false, reason: `minor side dust $${usdO.toFixed(4)}, skipping swap` };
  if (!cfg.live || !cfg.relayerKey) return { consolidated: false, reason: "dry-run: would consolidate" };
  const q = await swapQuote(cfg.oneinchKey, other, capital, otherAmount, maker);
  if (!q) return { consolidated: false, reason: "no swap route for consolidation" };
  const calls: Array<{ to: Address; value: bigint; data: Hex }> = [];
  const alw = (await client.readContract({
    address: other as Address, abi: ERC20_MIN, functionName: "allowance", args: [maker, V6_ROUTER],
  })) as bigint;
  if (alw < otherAmount) {
    calls.push({
      to: other as Address,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_MIN, functionName: "approve", args: [V6_ROUTER, MAX_UINT] }),
    });
  }
  calls.push({ to: q.to, value: q.value, data: q.data });
  await agentSignAndSubmit(maker, calls);
  return { consolidated: true, reason: `consolidated $${usdO.toFixed(4)} into capital` };
}

/**
 * Redeploy DOCK PROCEEDS (explicit pre/post-dock deltas) into the replacement
 * pair. Never reads wallet balances as capital: the wallet may hold unrelated
 * funds, and deploying those instead of the proceeds silently shrinks or
 * misallocates the rotation.
 */
export interface PreDockBaseline {
  token: string;
  bal: bigint;
}

export async function deployReplacement(
  cfg: RotatorConfig,
  c: Candidate,
  pre: PreDockBaseline[],
  deployPairs: Array<{ tokenA: string; tokenB: string }>,
): Promise<DeployResult> {
  const client = clientFor(cfg.rpcUrl);
  const pairToks = [...new Set(deployPairs.flatMap((p) => [p.tokenA.toLowerCase(), p.tokenB.toLowerCase()]))];
  let capital = deployPairs[0].tokenA;
  for (const t of pairToks) {
    if ((await pickPricedCapital(cfg.oneinchKey, t, t)) !== null) {
      capital = t;
      break;
    }
  }
  // Consolidate every non-capital proceeds token into capital so the ladder
  // ships the full pooled amount. Baselines are pre-dock reads; deltas are
  // proceeds, which excludes pre-existing wallet funds.
  const preMap = new Map(pre.map((p) => [p.token.toLowerCase(), p.bal]));
  let consolidated = false;
  for (const p of pre) {
    if (p.token.toLowerCase() === capital.toLowerCase()) continue;
    const post = await tokenBalance(client, p.token, c.maker);
    const delta = post > p.bal ? post - p.bal : 0n;
    if (delta === 0n) continue;
    const con = await consolidateProceeds(cfg, c.maker as Address, capital, p.token, delta, client);
    consolidated = consolidated || con.consolidated;
  }
  const decC = (await client.readContract({
    address: capital as Address, abi: ERC20_MIN, functionName: "decimals",
  })) as number;
  const capPre = preMap.get(capital.toLowerCase()) ?? 0n;
  const capPost = await tokenBalance(client, capital, c.maker);
  const amount = capPost > capPre ? capPost - capPre : 0n;
  if (amount === 0n) return { ok: false, reason: "dock proceeds are zero" };
  const res = await fetch(`${cfg.webBase}/api/agent/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cron-key": cfg.cronKey },
    body: JSON.stringify({
      maker: c.maker,
      capital,
      capitalAmount: formatUnits(amount, decC),
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
  if (ok > 0) return { ok: true, jobId, reason: `deployed ${ok}/${total}${con.consolidated ? ` (${con.reason})` : ""}${jobId ? ` job=${jobId}` : ""}` };
  return { ok: false, jobId, reason: `deploy yielded nothing (0/${total})` };
}
