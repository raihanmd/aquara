export interface RotatorConfig {
  webBase: string;
  rpcUrl: string;
  aqua: `0x${string}`;
  app: `0x${string}`;
  relayerKey: `0x${string}` | null;
  cronKey: string;
  oneinchKey: string;
  aiUrl: string;
  aiModel: string;
  aiKey: string;
  aiMaxTokens: number;
  aiEnabled: boolean;
  minGainBps: number;
  gasUsd: number;
  maxPerDay: number;
  groupMaxSize: number;
  topMaxPairs: number;
  topMinRatio: number;
  dailyGasCapUsd: number;
  intervalMs: number;
  port: number;
  live: boolean;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v.toLowerCase() === "true";
}

export function loadConfig(): RotatorConfig {
  const relayerKey = process.env.ROT_RELAYER_KEY ?? null;
  if (relayerKey && !/^0x[a-fA-F0-9]{64}$/.test(relayerKey)) {
    throw new Error("ROT_RELAYER_KEY must be 0x + 64 hex chars");
  }
  return {
    webBase: (process.env.ROT_WEB_BASE || "http://localhost:3000").replace(/\/$/, ""),
    rpcUrl: process.env.ROT_RPC_URL || "https://mainnet.base.org",
    aqua: (process.env.ROT_AQUA ||
      "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a") as `0x${string}`,
    app: (process.env.ROT_APP ||
      "0x111111338c5091e8440b67b168bae16a668ac0de") as `0x${string}`,
    relayerKey: relayerKey as `0x${string}` | null,
    cronKey: process.env.ROT_CRON_KEY || "",
    oneinchKey: process.env.ROT_ONEINCH_KEY || "",
    aiUrl: process.env.ROT_AI_URL || "https://ai.raihanmd.xyz/v1/chat/completions",
    aiModel: process.env.ROT_AI_MODEL || "n8n-1",
    aiKey: process.env.ROT_AI_KEY || "",
    aiMaxTokens: num("ROT_AI_MAX_TOKENS", 2000),
    aiEnabled: bool("ROT_AI_ENABLED", true),
    minGainBps: num("ROT_MIN_GAIN_BPS", 20000),
    gasUsd: num("ROT_GAS_USD", 0.08),
    groupMaxSize: num("ROT_GROUP_MAX_SIZE", 3),
    topMaxPairs: num("ROT_TOP_MAX_PAIRS", 3),
    topMinRatio: (() => {
      const v = Number(process.env.ROT_TOP_MIN_RATIO);
      return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
    })(),
    maxPerDay: num("ROT_MAX_PER_DAY", 1),
    dailyGasCapUsd: num("ROT_DAILY_GAS_CAP_USD", 1.0),
    intervalMs: num("ROT_INTERVAL_MS", 900000),
    port: num("ROT_PORT", 3102),
    live: (process.env.ROT_LIVE || "false").toLowerCase() === "true",
  };
}
