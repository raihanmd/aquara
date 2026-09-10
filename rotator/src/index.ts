import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { logInfo, logRotate, recentRotations } from "./log.js";
import { evaluateMaker, fetchMakers, todayRotationCount } from "./evaluate.js";
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
  const { candidate, reason, checked, outcomes } = await evaluateMaker(cfg, maker);
  if (!candidate) {
    for (const o of outcomes) {
      logRotate({ at: new Date().toISOString(), maker, strategyHash: o.hash, pair: o.pair, decision: "skip", reason: o.reasons.join("; "), verdict: o.verdict, aiLevel: o.aiLevel ?? undefined, dryRun });
    }
    if (outcomes.length === 0) {
      logRotate({ at: new Date().toISOString(), maker, strategyHash: "", pair: "", decision: "skip", reason: `checked=${checked} ${reason}`, dryRun });
    }
    return;
  }
  const at = new Date().toISOString();
  if (dryRun) {
    logRotate({ at, maker, strategyHash: candidate.strategyHash, pair: candidate.pair, decision: "dry-run", reason, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
    return;
  }
  // Pre-dock guard: the deploy pipeline budgets in USD. If neither proceeds
  // token has a price, the redeploy would fail AFTER docking and strand funds
  // in the wallet. Skip while the position is still intact. Needs ROT_ONEINCH_KEY.
  const priced = cfg.oneinchKey
    ? await pickPricedCapital(cfg.oneinchKey, candidate.tokenA, candidate.tokenB)
    : candidate.tokenA;
  if (!priced) {
    logRotate({ at, maker, strategyHash: candidate.strategyHash, pair: candidate.pair, decision: "skip", reason: "no USD price for either proceeds token - docking would strand funds", verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
    return;
  }
  // Replacement pair: best top earner by APY, falling back to the same pair
  // when tops are unreachable. Rotation moves capital toward yield, not back
  // into the same dead range.
  let pairOverride: { tokenA: string; tokenB: string } | undefined;
  try {
    const tops = (await (
      await fetch(`${cfg.webBase}/api/aqua/top?limit=6&sortBy=apy&chainIds=8453`, {
        headers: { accept: "application/json" },
      })
    ).json()) as { data?: Array<{ tokens?: Array<{ address?: string }> }> };
    const top = (tops?.data ?? []).find(
      (t) =>
        Array.isArray(t?.tokens) &&
        t.tokens.length >= 2 &&
        t.tokens[0].address &&
        t.tokens[1].address,
    );
    if (top?.tokens?.[0]?.address && top?.tokens?.[1]?.address) {
      pairOverride = {
        tokenA: String(top.tokens[0].address),
        tokenB: String(top.tokens[1].address),
      };
    }
  } catch {
    // tops unreachable: redeploy same pair
  }
  try {
    // Baseline both sides BEFORE docking: proceeds = post-dock minus baseline,
    // so unrelated wallet holdings never leak into the rotation capital.
    const rotClient = clientFor(cfg.rpcUrl);
    const [preA, preB] = await Promise.all([
      tokenBalance(rotClient, candidate.tokenA, candidate.maker),
      tokenBalance(rotClient, candidate.tokenB, candidate.maker),
    ]);
    const dockTx = await dockPosition({
      maker: candidate.maker as Address,
      aqua: cfg.aqua,
      app: cfg.app,
      strategyHash: candidate.strategyHash as Hex,
      tokens: [candidate.tokenA as Address, candidate.tokenB as Address],
    });
    await logDecision({
      maker,
      strategyHash: candidate.strategyHash,
      pair: candidate.pair,
      action: "dock",
      reason: `cron rotation dock (${candidate.verdict})`,
      txHash: dockTx,
    });
    logRotate({ at, maker, strategyHash: candidate.strategyHash, pair: candidate.pair, decision: "docked", reason: `docked ${dockTx.slice(0, 10)} deploying replacement`, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, txHash: dockTx, dryRun });
    const dep = await deployReplacement(
      cfg,
      candidate,
      { tokenA: candidate.tokenA, tokenB: candidate.tokenB, balA: preA, balB: preB },
      pairOverride,
    );
    logRotate({ at: new Date().toISOString(), maker, strategyHash: candidate.strategyHash, pair: pairOverride ? `${pairOverride.tokenA.slice(0, 6)}/${pairOverride.tokenB.slice(0, 6)}` : candidate.pair, decision: dep.ok ? "rotated" : "error", reason: dep.jobId ? `${dep.reason} job=${dep.jobId}` : dep.reason, verdict: candidate.verdict, aiLevel: candidate.aiLevel ?? undefined, dryRun });
  } catch (e: unknown) {
    const err = e as { shortMessage?: string; message?: string };
    logRotate({ at, maker, strategyHash: candidate.strategyHash, pair: candidate.pair, decision: "error", reason: String(err?.shortMessage ?? err?.message ?? e).slice(0, 200), verdict: candidate.verdict, dryRun });
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
