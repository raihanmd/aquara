export interface BotRoute {
  strategy: string;
  tokenIn: string;
  amountRaw: string;
  sizeUsd: number;
}

export interface BotConfig {
  maker: `0x${string}`;
  takerKey: `0x${string}` | null;
  rpcUrl: string;
  port: number;
  perTickBudgetUsd: number;
  maxTicksPerDay: number;
  dryRun: boolean;
  pairs: string[];
  intervalMs: number;
  strategies: string[];
  routes: BotRoute[];
  taker: `0x${string}`;
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function loadConfig(): BotConfig {
  const maker = required("BOT_MAKER", "0x0000000000000000000000000000000000000000");
  if (!/^0x[a-fA-F0-9]{40}$/.test(maker)) throw new Error("BOT_MAKER must be an address");
  const takerKey =  process.env.BOT_PK ?? null;
  if (takerKey && !/^0x[a-fA-F0-9]{64}$/.test(takerKey)) {
    throw new Error("BOT_PK must be 0x + 64 hex chars");
  }
  const strategies = (process.env.BOT_STRATEGIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[a-f0-9]{64}$/.test(s));
  let routes: BotRoute[] = [];
  try {
    const parsed = JSON.parse(process.env.BOT_ROUTES || "[]");
    if (Array.isArray(parsed)) {
      routes = parsed
        .filter(
          (r: any) =>
            typeof r?.strategy === "string" &&
            typeof r?.tokenIn === "string" &&
            typeof r?.amountRaw === "string",
        )
        .map((r: any) => ({
          strategy: String(r.strategy).toLowerCase(),
          tokenIn: String(r.tokenIn),
          amountRaw: String(r.amountRaw),
          sizeUsd: Number(r.sizeUsd ?? 0),
        }));
    }
  } catch {}
  const takerRaw = process.env.BOT_TAKER || maker;
  if (!/^0x[a-fA-F0-9]{40}$/.test(takerRaw)) throw new Error("BOT_TAKER must be an address");
  return {
    maker: maker as `0x${string}`,
    takerKey: takerKey as `0x${string}` | null,
    rpcUrl: process.env.BOT_RPC_URL || "https://mainnet.base.org",
    port: Number(process.env.BOT_PORT || 3101),
    perTickBudgetUsd: Number(process.env.BOT_TICK_BUDGET_USD || 5),
    maxTicksPerDay: Number(process.env.BOT_MAX_TICKS_PER_DAY || 48),
    dryRun: (process.env.BOT_LIVE || "false").toLowerCase() !== "true",
    pairs: (process.env.BOT_PAIRS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    intervalMs: Number(process.env.BOT_INTERVAL_MS || 300000),
    strategies,
    routes,
    taker: takerRaw as `0x${string}`,
  };
}

export function routeAllowed(cfg: BotConfig, strategyHash: string): boolean {
  if (cfg.strategies.length === 0) return true;
  return cfg.strategies.includes(strategyHash.toLowerCase());
}
