import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { logInfo, logRotate, recentRotations } from "./log.js";
import { evaluateMaker, fetchMakers, todayRotationCount } from "./evaluate.js";
import { pickTopPairs, scoreReplacementPairs, RAW_BALANCES_ABI } from "../../web/lib/rotation.ts";
import type { Candidate } from "./evaluate.js";
import { dockPosition } from "./dock.js";
import { postDeploy, ensureAllowances, mergeFundsToCapital, pickPricedCapital, preflightSwaps, selectCapital, clientFor, tokenBalance, tokenPriceUsd, ERC20_MIN } from "./deploy.js";
import { formatUnits, type Address, type Hex } from "viem";

const cfg = loadConfig();
if (cfg.relayerKey) process.env.RELAYER_PRIVATE_KEY ??= cfg.relayerKey;
process.env.NEXT_PUBLIC_RPC_URL ??= cfg.rpcUrl;

const app = new Hono();
const bootAt = new Date().toISOString();
let running = false;
let lastRunAt: string | null = null;
let nextRunAt: string | null = null;

async function logDecision(body: {
  maker: string;
  strategyHash: string;
  pair: string;
  action: string;
  reason: string;
  txHash?: string;
}): Promise<void> {
  try {
    await fetch(`${cfg.webBase}/api/agent/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-key": cfg.cronKey },
      body: JSON.stringify(body),
    });
  } catch {
    // history is best-effort; rotation outcome does not depend on it
  }
}

async function rotateOnce(maker: string): Promise<void> {
  const dryRun = !cfg.live || !cfg.relayerKey;
  const doneToday = await todayRotationCount(cfg.webBase, maker);
  if (doneToday >= cfg.maxPerDay) {
    logRotate({ at: new Date().toISOString(), maker, strategyHash: "", pair: "", decision: "skip", reason: `daily cap ${cfg.maxPerDay} reached`, dryRun });
    return;
  }
  // DB-persisted gas cap: rotations today (from decisions history) x est gas.
  if ((doneToday + 1) * cfg.gasUsd > cfg.dailyGasCapUsd) {
    logRotate({ at: new Date().toISOString(), maker, strategyHash: "", pair: "", decision: "skip", reason: `daily gas cap $${cfg.dailyGasCapUsd} would exceed`, dryRun });
    return;
  }
  const { candidate, candidates, reason, checked, outcomes } = await evaluateMaker(cfg, maker);
  if (!candidate || candidates.length === 0) {
    for (const o of outcomes) {
      logRotate({ at: new Date().toISOString(), maker, strategyHash: o.hash, pair: o.pair, decision: "skip", reason: o.reasons.join("; "), verdict: o.verdict, aiLevel: o.aiLevel ?? undefined, dryRun });
    }
    if (outcomes.length === 0) {
      logRotate({ at: new Date().toISOString(), maker, strategyHash: "", pair: "", decision: "skip", reason: `checked=${checked} ${reason}`, dryRun });
    }
    return;
  }
  // One rotation per tick takes up to groupMaxSize eligible positions,
  // whatever they hold. Proceeds pool in the wallet; destination tops overlap
  // with EACH OTHER (the Aqua advantage), not with the dead positions.
  const at = new Date().toISOString();
  async function rotateGroup(group: Candidate[]): Promise<boolean> {
  // Replacement pair: best top earner by APY, falling back to the first
  // group member's pair when tops are unreachable. Rotation moves capital
  // toward yield, not back into the same dead range.
  const groupHoldings = (c: Candidate) =>
    [c.tokenA, c.tokenB].map((t) => ({ token: t, usd: 1 }));
  let deployPairs = [{ tokenA: group[0].tokenA, tokenB: group[0].tokenB }];
  const symByAddr = new Map<string, string>();
  let topNote = "same pair (tops unreachable)";
  try {
    const tops = (await (
      await fetch(`${cfg.webBase}/api/aqua/top?limit=6&sortBy=apy&chainIds=8453`, {
        headers: { accept: "application/json" },
      })
    ).json()) as {
      data?: Array<{
        tokens?: Array<{ address?: string; symbol?: string }>;
        performance?: { fees?: { last24h?: { apy?: number }; last7d?: { apy?: number }; total?: { apy?: number } } };
      }>;
    };
    for (const t of tops?.data ?? [])
      for (const x of t.tokens ?? [])
        if (x.address && x.symbol) symByAddr.set(String(x.address).toLowerCase(), String(x.symbol));
    const holdings = group.flatMap(groupHoldings);
    const topsList = (tops?.data ?? []).map((t) => ({
      tokens: (t.tokens ?? []).map((x) => ({ address: x.address })),
      apy:
        t.performance?.fees?.last24h?.apy ??
        t.performance?.fees?.last7d?.apy ??
        t.performance?.fees?.total?.apy ??
        null,
    }));
    // apy mode: pure APY ranking, highest first. scored mode weights by
    // holdings overlap (fewer swaps) and may pick a lower APY.
    const ranked = cfg.topMode === "apy"
      ? topsList
          .filter((t) => t.apy !== null && (t.apy as number) > 0)
          .sort((a, b) => (b.apy as number) - (a.apy as number))
          .map((t) => ({
            tokenA: String(t.tokens[0]?.address ?? "").toLowerCase(),
            tokenB: String(t.tokens[1]?.address ?? "").toLowerCase(),
            apy: t.apy,
            overlapShare: 0,
            score: t.apy as number,
          }))
          .filter((r) => r.tokenA && r.tokenB)
      : scoreReplacementPairs(topsList, holdings);
    const picked = pickTopPairs(ranked, cfg.topMaxPairs, cfg.topMinRatio);
    if (picked.length > 0) {
      deployPairs = picked.map((r) => ({ tokenA: r.tokenA, tokenB: r.tokenB }));
      const first = picked[0];
      const rank = ranked.findIndex((r) => r.tokenA === first.tokenA && r.tokenB === first.tokenB) + 1;
      topNote = picked.length > 1
        ? `top ${picked.length} (best #${rank} APY ${first.apy}%)`
        : `top #${rank} APY ${first.apy}%`;
    }
  } catch {
    // tops unreachable: redeploy first member pair
  }
  const groupTag = group.map((c) => c.strategyHash.slice(0, 10)).join(",");
  const symOf = (a: string) => symByAddr.get(a.toLowerCase()) ?? a.slice(0, 6);
  const deployLabel = deployPairs.map((p) => `${symOf(p.tokenA)}/${symOf(p.tokenB)}`).join(" + ");
  const srcLabel = [...new Set(group.map((c) => (c.symbols ? `${c.symbols[0]}/${c.symbols[1]}` : `${c.tokenA.slice(0, 6)}/${c.tokenB.slice(0, 6)}`)))].join(" + ");
  if (dryRun) {
    logRotate({ at, maker, strategyHash: group.map((c) => c.strategyHash.slice(0, 10)).join("+"), pair: `${srcLabel} -> ${deployLabel}`, decision: "dry-run", reason: `group of ${group.length} (${srcLabel}) -> ${topNote} (${deployLabel}): ${reason}`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
    return true;
  }
  // Pre-dock guard on the DEPLOY pairs: the pipeline budgets in USD, so if
  // none of the deploy tokens has a price the redeploy fails AFTER docking
  // and strands funds. Skip while positions are intact. Needs ROT_ONEINCH_KEY.
  const deployToks = [...new Set(deployPairs.flatMap((p) => [p.tokenA, p.tokenB]))];
  let priced: string | null = null;
  if (cfg.oneinchKey) {
    for (const t of deployToks) {
      if ((await pickPricedCapital(cfg.oneinchKey, t, t)) !== null) {
        priced = t;
        break;
      }
    }
  } else {
    priced = deployToks[0];
  }
  if (!priced) {
    logRotate({ at, maker, strategyHash: groupTag, pair: deployLabel, decision: "skip", reason: "no USD price for deploy pairs - docking would strand funds", verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
    return true;
  }
  try {
    // Pre-dock snapshot: read raw position balances straight from chain
    // BEFORE docking (post-dock reads revert - strategy gone). Raw per token,
    // never USD-derived, never trusted from signal/API caches. Signal bals
    // are only the fallback when a read fails.
    const rotClient = clientFor(cfg.rpcUrl);
    const snap = new Map<string, bigint>();
    const snapRead = async (hash: string, tok: string): Promise<bigint | null> => {
      try {
        const [b] = (await rotClient.readContract({
          address: cfg.aqua as Address,
          abi: RAW_BALANCES_ABI,
          functionName: "rawBalances",
          args: [maker as Address, cfg.app as Address, hash as Hex, tok as Address],
        })) as unknown as [bigint, number];
        return b;
      } catch {
        return null;
      }
    };
    for (const c of group) {
      const pairs: Array<[string, string]> = [[c.tokenA, c.balA], [c.tokenB, c.balB]];
      for (const [tok, sigBal] of pairs) {
        const live = await snapRead(c.strategyHash, tok);
        let amt = live;
        if (amt === null) {
          try {
            amt = BigInt(sigBal);
          } catch {
            amt = 0n;
          }
        }
        if (amt > 0n) snap.set(tok.toLowerCase(), (snap.get(tok.toLowerCase()) ?? 0n) + amt);
      }
    }
    const funds = [...snap.entries()].map(([token, amount]) => ({ token, amount }));
    // Visibility: virtual (position commitment) vs wallet (real backing) side
    // by side. Under-backed positions show here before anything moves.
    const walletOf = new Map<string, bigint>();
    for (const f of funds) {
      walletOf.set(f.token, await tokenBalance(rotClient, f.token, maker).catch(() => -1n));
    }
    logRotate({ at, maker, strategyHash: groupTag, pair: srcLabel, decision: "snapshot", reason: `pre-dock snapshot ${funds.map((f) => `${f.token.slice(0, 6)} virtual=${f.amount} wallet=${walletOf.get(f.token)}`).join(", ") || "empty"}`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
    // Preflight BEFORE dock: prove every swap leg has a route while nothing
    // is spent. A missing route skips here, not after a paid dock.
    const preCapital = await selectCapital(cfg, deployPairs);
    const pre = await preflightSwaps(cfg, funds, preCapital, maker);
    if (!pre.ok) {
      logRotate({ at: new Date().toISOString(), maker, strategyHash: groupTag, pair: deployLabel, decision: "skip", reason: `${topNote} | preflight: ${pre.reason}`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
      return true;
    }
    // Approvals BEFORE dock: swaps (rotator merge + deploy cover) quote up
    // front and 1inch refuses without allowance. One batched tx for every
    // snapshot token, one-time per token, zero waste when it succeeds.
    const ap = await ensureAllowances(cfg, maker, [
      { token: preCapital, amount: 2n ** 256n - 1n },
      ...funds
        .filter((f) => f.token.toLowerCase() !== preCapital.toLowerCase())
        .map((f) => ({ token: f.token, amount: 2n ** 256n - 1n })),
    ]);
    if (!ap.ok) {
      logRotate({ at: new Date().toISOString(), maker, strategyHash: groupTag, pair: deployLabel, decision: "error", reason: `${topNote} | ${ap.reason} - nothing docked, nothing spent beyond the failed approve`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
      return false;
    }
    // Dock: cancels intents only, funds never move (self-custodial Aqua).
    const docked: string[] = [];
    for (const c of group) {
      const dockTx = await dockPosition({
        maker: maker as Address,
        aqua: cfg.aqua,
        app: cfg.app,
        strategyHash: c.strategyHash as Hex,
        tokens: [c.tokenA as Address, c.tokenB as Address],
      });
      docked.push(c.strategyHash);
      await logDecision({
        maker,
        strategyHash: c.strategyHash,
        pair: c.pair,
        action: "dock",
        reason: `cron rotation dock group ${groupTag} (${c.verdict})`,
        txHash: dockTx,
      });
      logRotate({ at, maker, strategyHash: c.strategyHash, pair: c.pair, decision: "docked", reason: `docked ${dockTx.slice(0, 10)} group ${groupTag}`, verdict: c.verdict, aiLevel: c.aiLevel ?? undefined, txHash: dockTx, dryRun });
    }
    // Merge everything to capital FIRST so /deploy receives a pure-capital
    // wallet top-up. Budget = snapshot capital-side + measured swap deltas
    // (real received, never estimates), so deploy planning cannot drift.
    // Slippage is per-maker DB state (same source the deploy dialog uses),
    // never a rotator env var. Best-effort: default 0.5 on read failure.
    let slip = 0.5;
    try {
      const r = await fetch(`${cfg.webBase}/api/settings?maker=${maker}`, { headers: { accept: "application/json" } });
      if (r.ok) {
        const j = (await r.json()) as { slippage?: number };
        if (typeof j?.slippage === "number" && j.slippage >= 0.05 && j.slippage <= 10) slip = j.slippage;
      }
    } catch {}
    const merged = await mergeFundsToCapital(cfg, maker, funds, preCapital, slip);
    if (!merged.ok) {
      logRotate({ at: new Date().toISOString(), maker, strategyHash: groupTag, pair: deployLabel, decision: "error", reason: `${topNote} | ${merged.reason} - dock already executed, funds stay in wallet`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
      return false;
    }
    const decC = (await rotClient.readContract({
      address: preCapital as Address, abi: ERC20_MIN,
      functionName: "decimals",
    }).catch(() => 18)) as number;
    const capSide = funds.find((f) => f.token.toLowerCase() === preCapital.toLowerCase())?.amount ?? 0n;
    const budget = capSide + merged.swappedIn;
    // Size reconciliation: snapshot USD vs merged budget USD. Beyond 3% drift
    // something moved under us - flag loudly, still deploy (the budget is
    // measured, honest whatever it is).
    let recon = "";
    try {
      let snapUsd = 0;
      for (const f of funds) {
        const [dec, px] = await Promise.all([
          rotClient.readContract({ address: f.token as Address, abi: ERC20_MIN, functionName: "decimals" }).catch(() => 18) as Promise<number>,
          tokenPriceUsd(cfg.oneinchKey, f.token),
        ]);
        if (px !== null) snapUsd += (Number(f.amount) / 10 ** dec) * px;
      }
      const pxC = await tokenPriceUsd(cfg.oneinchKey, preCapital);
      if (snapUsd > 0 && pxC !== null) {
        const budgetUsd = (Number(budget) / 10 ** decC) * pxC;
        const drift = 1 - budgetUsd / snapUsd;
        recon = ` reconcile $${snapUsd.toFixed(4)} -> $${budgetUsd.toFixed(4)} (${(drift * 100).toFixed(1)}% fees/slippage)${drift > 0.03 ? " OVER 3% - CHECK" : ""}`;
      }
    } catch {}
    const dep = await postDeploy(
      cfg,
      { ...candidate, tokenA: deployPairs[0].tokenA, tokenB: deployPairs[0].tokenB },
      preCapital,
      formatUnits(budget, decC),
      deployPairs,
    );
    logRotate({ at: new Date().toISOString(), maker, strategyHash: groupTag, pair: deployLabel, decision: dep.ok ? "rotated" : "error", reason: `${topNote} | ${dep.jobId ? `${dep.reason} job=${dep.jobId}` : dep.reason}${recon}`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
    return dep.ok;
  } catch (e: unknown) {
    const err = e as { shortMessage?: string; message?: string };
    logRotate({ at, maker, strategyHash: candidate.strategyHash, pair: candidate.pair, decision: "error", reason: String(err?.shortMessage ?? err?.message ?? e).slice(0, 200), verdict: candidate.verdict, dryRun });
    return false;
  }
  }

  // One rotation per tick takes up to groupMaxSize eligible positions,
  // whatever they hold. Source overlap is irrelevant: proceeds pool in the
  // wallet and deploy into the top-scoring pairs, which overlap with EACH
  // OTHER (the Aqua advantage), not with the dead positions.
  const batch = candidates.slice(0, Math.max(1, cfg.groupMaxSize));
  if (batch.length > 0) {
    await rotateGroup(batch);
  }
}

async function scheduledRun(): Promise<void> {
  if (running) {
    logInfo("tick-skip-busy", {});
    return;
  }
  running = true;
  lastRunAt = new Date().toISOString();
  try {
    const makers = await fetchMakers(cfg.webBase);
    for (const maker of makers) {
      await rotateOnce(maker);
    }
  } catch (e: unknown) {
    logInfo("sched-err", { msg: String((e as Error)?.message ?? e).slice(0, 200) });
  } finally {
    running = false;
    nextRunAt = new Date(Date.now() + cfg.intervalMs).toISOString();
  }
}

app.get("/health", (c) =>
  c.json({ ok: true, uptime: bootAt, live: cfg.live, dryRun: !cfg.live || !cfg.relayerKey }),
);

app.get("/status", (c) =>
  c.json({ live: cfg.live, intervalMs: cfg.intervalMs, lastRunAt, nextRunAt, recent: recentRotations() }),
);

app.post("/cron/tick", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const maker = typeof body.maker === "string" ? body.maker : null;
  if (maker) {
    await rotateOnce(maker);
  } else {
    await scheduledRun();
  }
  return c.json({ ok: true, recent: recentRotations().slice(0, 5) });
});

logInfo("boot", { port: cfg.port, live: cfg.live, intervalMs: cfg.intervalMs });

nextRunAt = new Date(Date.now() + 10000).toISOString();
setTimeout(() => {
  scheduledRun().catch((e) => logInfo("sched-err", { msg: String((e as Error)?.message ?? e).slice(0, 200) }));
}, 10000);
setInterval(() => {
  scheduledRun().catch((e) => logInfo("sched-err", { msg: String((e as Error)?.message ?? e).slice(0, 200) }));
}, cfg.intervalMs);

export default { port: cfg.port, fetch: app.fetch };
