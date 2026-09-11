import { describe, expect, test, afterEach } from "bun:test";
import { evaluateMaker, todayRotationCount } from "./src/evaluate.ts";
import type { RotatorConfig } from "./src/config.ts";

const MAKER = "0x08dc514b8ba9015a74972da8bda5027fd91943e1";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const DAI = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const H = (n: number) => `0x${String(n).padStart(64, "2")}`;

const cfg = {
  webBase: "http://web",
  rpcUrl: "http://rpc",
  aqua: "0xaqua",
  app: "0xapp",
  relayerKey: null,
  cronKey: "",
  oneinchKey: "",
  aiUrl: "http://ai",
  aiModel: "n8n-1",
  aiKey: "k",
  aiMaxTokens: 2000,
  aiEnabled: true,
  minGainBps: 20000,
  gasUsd: 0.08,
  maxPerDay: 1,
  dailyGasCapUsd: 1.0,
  groupMaxSize: 3,
  bands: [{ widthBps: 500, weightBps: 5000 }],
  intervalMs: 900000,
  port: 3102,
  live: false,
} as unknown as RotatorConfig;

function sig(
  n: number,
  pair: [string, string],
  verdict: string,
  eligible: boolean,
  extra: Record<string, unknown> = {},
) {
  return {
    strategyHash: H(n),
    eligible,
    headline: eligible ? "Not ideal — better to rotate" : "Healthy",
    reasons: eligible ? ["Out of range"] : ["In range and fillable"],
    verdict,
    trash: eligible,
    trashReason: eligible ? "demo-force" : null,
    mode: "aggressive",
    pair: `${pair[0].slice(0, 6)}/${pair[1].slice(0, 6)}`,
    tokenA: pair[0],
    tokenB: pair[1],
    balA: "100",
    balB: "100",
    quotedOut: "1000",
    gainUsd: 10,
    ...extra,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubWeb(opts: { makers?: string[]; strategies?: unknown[]; signals?: unknown[]; decisions?: unknown[]; aiLevels?: Record<string, string> }) {
  const aiBody = {
    choices: [
      {
        message: {
          content: JSON.stringify(
            (opts.signals as Array<{ strategyHash: string }>)?.map((s) => ({
              hash: s.strategyHash,
              level: opts.aiLevels?.[s.strategyHash.toLowerCase()] ?? "HIGH",
            })) ?? [],
          ),
        },
      },
    ],
  };
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.includes("/api/users")) return ok(opts.makers ?? [MAKER]);
    if (u.includes("/api/strategies")) return ok(opts.strategies ?? []);
    if (u.includes("/api/rotation/signal")) return ok({ signals: opts.signals ?? [] });
    if (u.includes("/api/agent/decisions")) return ok(opts.decisions ?? []);
    if (u.includes("http://ai")) return ok(aiBody);
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

const STRATS = [1, 2].map((n) => ({ strategyHash: H(n), mode: "aggressive" }));

describe("evaluateMaker", () => {
  test("collects eligible group sharing dominant token", async () => {
    const signals = [
      sig(1, [USDC, WETH], "oor-suspect", true),
      sig(2, [USDC, DAI], "depleted", true),
      sig(3, [WETH, CBBTC], "healthy", false),
    ];
    stubWeb({ strategies: STRATS, signals });
    const r = await evaluateMaker(cfg, MAKER);
    expect(r.candidates.length).toBe(2);
    expect(r.candidate?.strategyHash).toBe(H(1));
    expect(r.outcomes.length).toBe(3);
  });
  test("AI non-HIGH blocks judgment positions but dead capital passes", async () => {
    const signals = [sig(1, [USDC, WETH], "oor-suspect", true)];
    stubWeb({ strategies: STRATS, signals, aiLevels: { [H(1).toLowerCase()]: "MEDIUM" } });
    const r = await evaluateMaker(cfg, MAKER);
    // dead capital bypasses AI: still candidate
    expect(r.candidates.length).toBe(1);
  });
  test("kill-switch on no managed rows", async () => {
    stubWeb({ strategies: [], signals: [] });
    const r = await evaluateMaker(cfg, MAKER);
    expect(r.reason).toMatch(/kill-switch/);
    expect(r.candidates).toEqual([]);
  });
  test("not delegated when registry lacks maker", async () => {
    stubWeb({ makers: ["0xother"], strategies: STRATS, signals: [] });
    const r = await evaluateMaker(cfg, MAKER);
    expect(r.reason).toMatch(/not delegated/);
  });
  test("empty signals explained, not silent", async () => {
    stubWeb({ strategies: STRATS, signals: [] });
    const r = await evaluateMaker(cfg, MAKER);
    expect(r.candidate).toBe(null);
    expect(r.reason).toMatch(/no signals/);
  });
});

describe("todayRotationCount", () => {
  test("counts only today's cron rotations", async () => {
    const today = new Date().toISOString().slice(0, 10);
    stubWeb({
      decisions: [
        { reason: "cron rotation (aggressive)", createdAt: `${today}T01:00:00.000Z` },
        { reason: "agent deployed (aggressive)", createdAt: `${today}T02:00:00.000Z` },
        { reason: "cron rotation (aggressive)", createdAt: "2020-01-01T00:00:00.000Z" },
      ],
    });
    expect(await todayRotationCount("http://web", MAKER)).toBe(1);
  });
});
