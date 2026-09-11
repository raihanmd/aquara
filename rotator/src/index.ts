import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { logInfo, logRotate, recentRotations } from "./log.js";
import { evaluateMaker, fetchMakers, todayRotationCount } from "./evaluate.js";
import { pickGroup, pickTopPairs, scoreReplacementPairs } from "../../web/lib/rotation.ts";
import type { Candidate } from "./evaluate.js";
import { dockPosition } from "./dock.js";
import { deployReplacement, pickPricedCapital, tokenBalance, clientFor } from "./deploy.js";
import type { Address, Hex } from "viem";

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
  // Group rotation: candidates sharing one token rotate together so the
  // shared side is never swapped. Every group is processed per tick until
  // none remain (bounded), so "rotate everything" needs no manual repeats.
  const at = new Date().toISOString();
  async function rotateGroup(group: Candidate[], dominant: string): Promise<boolean> {
  // Replacement pair: best top earner by APY, falling back to the first
  // group member's pair when tops are unreachable. Rotation moves capital
  // toward yield, not back into the same dead range.
  const groupHoldings = (c: Candidate) =>
    [c.tokenA, c.tokenB].map((t) => ({ token: t, usd: 1 }));
  let deployPairs = [{ tokenA: group[0].tokenA, tokenB: group[0].tokenB }];
  let topNote = "same pair (tops unreachable)";
  try {
    const tops = (await (
      await fetch(`${cfg.webBase}/api/aqua/top?limit=6&sortBy=apy&chainIds=8453`, {
        headers: { accept: "application/json" },
      })
    ).json()) as {
      data?: Array<{
        tokens?: Array<{ address?: string }>;
        performance?: { fees?: { last24h?: { apy?: number }; last7d?: { apy?: number }; total?: { apy?: number } } };
      }>;
    };
    const holdings = group.flatMap(groupHoldings);
    const ranked = scoreReplacementPairs(
      (tops?.data ?? []).map((t) => ({
        tokens: (t.tokens ?? []).map((x) => ({ address: x.address })),
        apy:
          t.performance?.fees?.last24h?.apy ??
          t.performance?.fees?.last7d?.apy ??
          t.performance?.fees?.total?.apy ??
          null,
      })),
      holdings,
    );
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
  const deployLabel = deployPairs.map((p) => `${p.tokenA.slice(0, 6)}/${p.tokenB.slice(0, 6)}`).join(" + ");
  if (dryRun) {
    logRotate({ at, maker, strategyHash: group.map((c) => c.strategyHash.slice(0, 10)).join("+"), pair: deployLabel, decision: "dry-run", reason: `group of ${group.length} sharing ${dominant.slice(0, 10)} -> ${topNote}: ${reason}`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
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
    // Baseline every group token BEFORE docking: proceeds = post-dock minus
    // baselines, so unrelated wallet holdings never leak into the capital.
    const rotClient = clientFor(cfg.rpcUrl);
    const groupToks = [...new Set(group.flatMap((c) => [c.tokenA.toLowerCase(), c.tokenB.toLowerCase()]))];
    const preBars = await Promise.all(
      groupToks.map(async (t) => ({ token: t, bal: await tokenBalance(rotClient, t, maker) })),
    );
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
    const dep = await deployReplacement(
      cfg,
      { ...candidate, tokenA: deployPairs[0].tokenA, tokenB: deployPairs[0].tokenB },
      preBars,
      deployPairs,
    );
    logRotate({ at: new Date().toISOString(), maker, strategyHash: groupTag, pair: deployLabel, decision: dep.ok ? "rotated" : "error", reason: `${topNote} | ${dep.jobId ? `${dep.reason} job=${dep.jobId}` : dep.reason}`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
    return dep.ok;
  } catch (e: unknown) {
    const err = e as { shortMessage?: string; message?: string };
    logRotate({ at, maker, strategyHash: candidate.strategyHash, pair: candidate.pair, decision: "error", reason: String(err?.shortMessage ?? err?.message ?? e).slice(0, 200), verdict: candidate.verdict, dryRun });
    return false;
  }
  }

  // Rotate every group: after one group is docked its members are gone from
  // the candidate set, so the next group forms from the remainder.
  let remaining = [...candidates];
  for (let round = 0; round < 5 && remaining.length > 0; round++) {
    const picked = pickGroup(remaining, cfg.groupMaxSize);
    if (picked.group.length === 0) break;
    const progressed = await rotateGroup(picked.group, picked.dominant);
    remaining = remaining.filter((c) => !picked.group.includes(c));
    if (!progressed) break;
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
