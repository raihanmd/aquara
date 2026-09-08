import { Hono } from "hono";
import { loadConfig, routeAllowed } from "./config.js";
import { logInfo, recentTicks } from "./log.js";
import { executeFill, type FillInput } from "./engine.js";

const cfg = loadConfig();
const app = new Hono();
const bootAt = new Date().toISOString();
let tickCount = 0;
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;
let running = false;
let lastRunAt: string | null = null;
let nextRunAt: string | null = null;

if (cfg.strategies.length === 0) {
  logInfo("warn-no-allowlist", { msg: "BOT_STRATEGIES empty - all strategies allowed" });
}

async function runTick(input: FillInput): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  if (!routeAllowed(cfg, input.strategyHash)) {
    const reason = "strategy not in BOT_STRATEGIES allowlist - refused";
    logInfo("tick-refused", { strategy: input.strategyHash.slice(0, 10), reason });
    return { ok: false, decision: "blocked", reason };
  }
  if (input.sizeUsd > cfg.perTickBudgetUsd) {
    const reason = `sizeUsd ${input.sizeUsd} over per-tick budget ${cfg.perTickBudgetUsd} - refused`;
    logInfo("tick-refused", { strategy: input.strategyHash.slice(0, 10), reason });
    return { ok: false, decision: "blocked", reason };
  }
  if (dayCount >= cfg.maxTicksPerDay) {
    const reason = `daily cap ${cfg.maxTicksPerDay} reached - refused`;
    logInfo("tick-refused", { reason });
    return { ok: false, decision: "blocked", reason };
  }
  tickCount += 1;
  dayCount += 1;
  logInfo("tick-start", { n: tickCount, strategy: input.strategyHash.slice(0, 10) });
  try {
    const result = await executeFill(cfg, input);
    return { ok: true, tick: tickCount, ...result };
  } catch (e: any) {
    const reason = `tick crashed: ${String(e?.shortMessage || e?.message || e).slice(0, 300)}`;
    logInfo("tick-crash", { strategy: input.strategyHash.slice(0, 10), reason });
    if (process.env.BOT_DEBUG_STACK === "true") console.log((e as any)?.stack ?? e);
    return { ok: false, tick: tickCount, decision: "error", reason };
  }
}

async function scheduledRun(): Promise<void> {
  if (running) {
    logInfo("tick-skip-busy", {});
    return;
  }
  if (cfg.routes.length === 0) return;
  running = true;
  lastRunAt = new Date().toISOString();
  try {
    for (const r of cfg.routes) {
      await runTick({
        strategyHash: r.strategy,
        tokenA: "",
        tokenB: "",
        tokenIn: r.tokenIn,
        amountRaw: r.amountRaw,
        mode: null,
        sizeUsd: r.sizeUsd,
        taker: cfg.taker,
        exactOut: (r as any).exactOut === true,
      });
    }
  } finally {
    running = false;
    nextRunAt = new Date(Date.now() + cfg.intervalMs).toISOString();
  }
}

app.get("/health", (c) =>
  c.json({ ok: true, uptime: bootAt, ticks: tickCount, dryRun: cfg.dryRun }),
);

app.get("/status", (c) =>
  c.json({
    maker: cfg.maker,
    dryRun: cfg.dryRun,
    ticks: tickCount,
    dayCount,
    intervalMs: cfg.intervalMs,
    routes: cfg.routes.length,
    allowlist: cfg.strategies,
    lastRunAt,
    nextRunAt,
    recent: recentTicks(),
  }),
);

app.post("/cron/tick", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const out = await runTick({
    strategyHash: String(body.strategyHash ?? ""),
    tokenA: String(body.tokenA ?? ""),
    tokenB: String(body.tokenB ?? ""),
    tokenIn: String(body.tokenIn ?? body.tokenA ?? ""),
    amountRaw: String(body.amountRaw ?? "0"),
    mode: (body.mode as string | null) ?? null,
    sizeUsd: Number(body.sizeUsd ?? cfg.perTickBudgetUsd),
    taker: body.taker ? String(body.taker) : cfg.taker,
    exactOut: body.exactOut === true,
  });
  return c.json(out);
});

logInfo("boot", {
  port: cfg.port,
  maker: cfg.maker,
  dryRun: cfg.dryRun,
  intervalMs: cfg.intervalMs,
  routes: cfg.routes.length,
});

if (cfg.routes.length > 0) {
  nextRunAt = new Date(Date.now() + 10000).toISOString();
  setTimeout(() => {
    scheduledRun().catch((e) => logInfo("sched-err", { msg: String(e?.message ?? e).slice(0, 200) }));
  }, 10000);
  setInterval(() => {
    scheduledRun().catch((e) => logInfo("sched-err", { msg: String(e?.message ?? e).slice(0, 200) }));
  }, cfg.intervalMs);
}

export default {
  port: cfg.port,
  fetch: app.fetch,
};
