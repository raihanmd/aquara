import { describe, expect, test } from "bun:test";
import {
  decideVerdict,
  decideTrash,
  describeEligibility,
  estimateGainUsd,
  isPriceOutOfRange,
  passesGainGate,
  pickGroup,
  pickTopPairs,
  scoreReplacementPairs,
  usdPerRaw,
  ageHoursSince,
  DEFAULT_TRASH,
} from "./rotation.ts";

const T = {
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  weth: "0x4200000000000000000000000000000000000006",
  cbbtc: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  aero: "0x940181a94a35a4569e4529aea53eb53f67edb838",
  dai: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
  eurc: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
};

const H = (n: number) => `0x${String(n).padStart(64, "1")}`;

// ── verdict ladder ──────────────────────────────────────────────
describe("decideVerdict", () => {
  const base = { balA: 10n, balB: 10n, sideDepleted: false, quoteOk: true, allowanceOk: true, infraDegraded: false };
  test("healthy when everything fine", () => {
    expect(decideVerdict(base)).toBe("healthy");
  });
  test("unreadable wins over everything", () => {
    expect(decideVerdict({ ...base, infraDegraded: true, balA: 0n, balB: 0n })).toBe("unreadable");
    expect(decideVerdict({ ...base, balA: -1n })).toBe("unreadable");
  });
  test("depleted when both zero", () => {
    expect(decideVerdict({ ...base, balA: 0n, balB: 0n })).toBe("depleted");
  });
  test("side-depleted before quote check", () => {
    expect(decideVerdict({ ...base, sideDepleted: true, quoteOk: false })).toBe("side-depleted");
  });
  test("single-sided funded is healthy, not depleted", () => {
    expect(decideVerdict({ ...base, balB: 0n })).toBe("healthy");
  });
  test("quote revert means oor-suspect", () => {
    expect(decideVerdict({ ...base, quoteOk: false })).toBe("oor-suspect");
  });
  test("thin allowance last", () => {
    expect(decideVerdict({ ...base, allowanceOk: false })).toBe("thin-allowance");
  });
});

// ── trash ───────────────────────────────────────────────────────
describe("decideTrash", () => {
  const base = {
    strategyHash: H(1),
    volume24h: 10,
    volume7d: 70,
    apy: 12,
    feesTotalUsd: 1,
    sizeUsd: 100,
    ageHours: 30,
    topApy: 20,
    thresholds: DEFAULT_TRASH,
  };
  test("healthy position is not trash", () => {
    expect(decideTrash(base)).toEqual({ trash: false, reason: null });
  });
  test("demo-force wins over grace", () => {
    expect(
      decideTrash({
        ...base,
        ageHours: 0.5,
        thresholds: { ...DEFAULT_TRASH, demoForceTrashHashes: [H(1)] },
      }).trash,
    ).toBe(true);
  });
  test("grace protects fresh positions from volume trash", () => {
    expect(
      decideTrash({ ...base, volume24h: 0, volume7d: 0, ageHours: 1 }),
    ).toEqual({ trash: false, reason: null });
  });
  test("zero volume after grace is trash", () => {
    expect(decideTrash({ ...base, volume24h: 0, volume7d: 0 }).reason).toBe(
      "zero-volume-both-windows",
    );
  });
  test("low absolute volume is trash", () => {
    expect(decideTrash({ ...base, volume24h: 0.01 }).reason).toBe("low-volume-24h");
  });
  test("missing volume never false-trashes", () => {
    expect(
      decideTrash({ ...base, volume24h: null, volume7d: null, apy: null }).trash,
    ).toBe(false);
  });
  test("underperforming vs top", () => {
    expect(
      decideTrash({ ...base, apy: 1, topApy: 20 }).reason,
    ).toBe("underperforming-vs-top");
  });
  test("null topApy disables relative check", () => {
    expect(decideTrash({ ...base, apy: 0, topApy: null }).trash).toBe(false);
  });
  test("low volume vs size after min age", () => {
    // $2 volume passes the $1 absolute bar but is 2% of $100 size < 5%
    expect(
      decideTrash({ ...base, volume24h: 2, volume7d: 50 }).reason,
    ).toBe("low-volume-vs-size");
  });
  test("efficiency rules respect min age", () => {
    expect(
      decideTrash({ ...base, volume24h: 0.1, volume7d: 50, ageHours: 2 }).trash,
    ).toBe(false);
  });
  test("low fee vs size", () => {
    // $0.05 fees on $100 size = 0.05% < 0.1% threshold, volume healthy
    expect(
      decideTrash({ ...base, volume24h: 10, volume7d: 70, feesTotalUsd: 0.05 }).reason,
    ).toBe("low-fee-vs-size");
  });
  test("zero size never efficiency-trashes", () => {
    expect(
      decideTrash({ ...base, volume24h: 2, volume7d: 50, sizeUsd: 0 }).trash,
    ).toBe(false);
  });
});

// ── eligibility ─────────────────────────────────────────────────
describe("describeEligibility", () => {
  const gain = { gainUsd: 10, gasUsd: 0.08, minBps: 20000 };
  test("dead capital bypasses gain and AI gates", () => {
    for (const verdict of ["oor-suspect", "depleted", "side-depleted"] as const) {
      const s = describeEligibility({
        verdict, trash: false, trashReason: null, ...gain, aiLevel: null, aiEnforced: true,
      });
      expect(s.eligible).toBe(true);
    }
  });
  test("healthy trash needs gain + AI", () => {
    const base = { verdict: "healthy" as const, trash: true, trashReason: "low-volume-24h" as const, ...gain };
    expect(describeEligibility({ ...base, aiLevel: null, aiEnforced: true }).eligible).toBe(false);
    expect(describeEligibility({ ...base, aiLevel: "MEDIUM", aiEnforced: true }).eligible).toBe(false);
    expect(describeEligibility({ ...base, aiLevel: "HIGH", aiEnforced: true }).eligible).toBe(true);
    expect(describeEligibility({ ...base, aiLevel: null, aiEnforced: false }).eligible).toBe(true);
  });
  test("small gain blocks healthy trash honestly", () => {
    const s = describeEligibility({
      verdict: "healthy", trash: true, trashReason: "low-volume-24h",
      gainUsd: 0.0004, gasUsd: 0.08, minBps: 20000, aiEnforced: false,
    });
    expect(s.eligible).toBe(false);
    expect(s.headline).toMatch(/gain too small/);
  });
  test("unreadable never eligible", () => {
    expect(
      describeEligibility({ verdict: "unreadable", trash: false, trashReason: null, ...gain, aiEnforced: false }).eligible,
    ).toBe(false);
  });
});

// ── gain gate boundaries ────────────────────────────────────────
describe("passesGainGate", () => {
  test("exactly 2x passes", () => {
    expect(passesGainGate(0.16, 0.08, 20000)).toEqual({ pass: true, bps: 20000 });
  });
  test("19999 bps fails", () => {
    expect(passesGainGate(0.15999, 0.08, 20000).pass).toBe(false);
  });
  test("zero/negative inputs fail", () => {
    expect(passesGainGate(0, 0.08, 20000).pass).toBe(false);
    expect(passesGainGate(1, 0, 20000).pass).toBe(false);
  });
});

// ── gain units (the $133k dust bug) ─────────────────────────────
describe("estimateGainUsd", () => {
  test("18-decimal dust stays dust", () => {
    // 2.6e13 wei of an 18-dec token at $3000 = $0.00008, not $133k
    const rate = 3000 / 1e18;
    expect(estimateGainUsd(26795615013687n, rate, 50)).toBeLessThan(0.01);
  });
  test("null rate yields zero, never NaN", () => {
    expect(estimateGainUsd(1000000n, null, 50)).toBe(0);
  });
  test("usdc math: 2 USDC quoted at 0.5% = $0.01", () => {
    expect(estimateGainUsd(2000000n, 1 / 1e6, 50)).toBeCloseTo(0.01, 4);
  });
});

describe("usdPerRaw", () => {
  const toks = [
    { address: T.usdc, currentBalance: { raw: "25000", usd: 0.025001 } },
    { address: T.weth, currentBalance: { raw: "402137564749999", usd: 0.990558 } },
  ];
  test("derives per-raw rate", () => {
    expect(usdPerRaw(toks, T.usdc)).toBeCloseTo(0.025001 / 25000, 15);
  });
  test("string/number/missing balances yield null", () => {
    expect(usdPerRaw([{ address: T.usdc, currentBalance: "100" }], T.usdc)).toBe(null);
    expect(usdPerRaw([], T.usdc)).toBe(null);
    expect(usdPerRaw([{ address: T.usdc, currentBalance: { raw: "0", usd: 0 } }], T.usdc)).toBe(null);
  });
});

// ── price OOR ───────────────────────────────────────────────────
describe("isPriceOutOfRange", () => {
  // spot 3000 USDC/WETH style: hi=USDC(addr higher?) use simple numbers
  const toks = [
    { address: T.usdc, decimals: 6, currentBalance: { raw: "1000000", usd: 1 } },
    { address: T.weth, decimals: 18, currentBalance: { raw: "1000000000000000000", usd: 3000 } },
  ];
  test("null on missing inputs, never false-positive", () => {
    expect(isPriceOutOfRange({ tokenA: T.usdc, tokenB: T.weth, priceMin: null, priceMax: "1", tokens: toks })).toBe(null);
    expect(
      isPriceOutOfRange({ tokenA: T.usdc, tokenB: T.weth, decA: 6, decB: 18, priceMin: "1", priceMax: "2", tokens: [] }),
    ).toBe(null);
  });
  test("in-band spot returns false", () => {
    // rawP convention: H(human hi per lo) * 1e18 * 10^(decHi-decLo); wide band always contains
    expect(
      isPriceOutOfRange({ tokenA: T.usdc, tokenB: T.weth, decA: 6, decB: 18, priceMin: "1", priceMax: "99999999999999999999999999999999999999", tokens: toks }),
    ).toBe(false);
  });
  test("far-off band returns true", () => {
    expect(
      isPriceOutOfRange({ tokenA: T.usdc, tokenB: T.weth, decA: 6, decB: 18, priceMin: "99999999999999999999999999999999999999", priceMax: "99999999999999999999999999999999999999999", tokens: toks }),
    ).toBe(true);
  });
});

// ── grouping + scoring ──────────────────────────────────────────
describe("pickGroup", () => {
  const c = (h: string, a: string, b: string) => ({ strategyHash: h, tokenA: a, tokenB: b });
  test("groups by dominant shared token", () => {
    const { group, dominant } = pickGroup(
      [c(H(1), T.usdc, T.weth), c(H(2), T.usdc, T.dai), c(H(3), T.weth, T.cbbtc)],
      3,
    );
    expect(group.map((x) => x.strategyHash)).toEqual([H(1), H(2)]);
    expect(dominant).toBe(T.usdc);
  });
  test("lone candidate forms its own group", () => {
    const { group } = pickGroup([c(H(1), T.usdc, T.weth)], 3);
    expect(group.length).toBe(1);
  });
  test("caps at maxSize", () => {
    const many = [1, 2, 3, 4, 5].map((n) => c(H(n), T.usdc, T.weth));
    expect(pickGroup(many, 3).group.length).toBe(3);
  });
  test("empty in, empty out", () => {
    expect(pickGroup([], 3)).toEqual({ group: [], dominant: "" });
  });
});

describe("scoreReplacementPairs", () => {
  const holdings = [
    { token: T.usdc, usd: 60 },
    { token: T.weth, usd: 30 },
    { token: T.dai, usd: 10 },
  ];
  const tops = [
    { tokens: [{ address: T.eurc }, { address: T.aero }], apy: 60 },
    { tokens: [{ address: T.aero }, { address: T.usdc }], apy: 40 },
    { tokens: [{ address: T.weth }, { address: T.cbbtc }], apy: 25 },
    { tokens: [{ address: T.dai }, { address: "0xusdt" }], apy: 5 },
  ];
  test("overlap beats raw APY", () => {
    const ranked = scoreReplacementPairs(tops, holdings);
    // AERO/USDC: 40 * (0.5 + 0.5*0.6) = 32 > EURC/AERO: 60 * 0.5 = 30
    expect(ranked[0].tokenA).toBe(T.aero);
    expect(ranked[0].tokenB).toBe(T.usdc);
  });
  test("skips junk tops", () => {
    const ranked = scoreReplacementPairs(
      [{ tokens: [{ address: "" }], apy: 99 }, { tokens: [{ address: T.usdc }], apy: 99 }, ...tops],
      holdings,
    );
    expect(ranked.every((r) => r.tokenA && r.tokenB && (r.apy ?? 0) > 0)).toBe(true);
  });
  test("zero holdings still ranks by half APY", () => {
    const ranked = scoreReplacementPairs(tops, []);
    expect(ranked[0].apy).toBe(60);
  });
});

// ── user scenario: EURC/AERO + EURC/wstETH held, USDC/* on top ────
describe("correlated rotation scenario", () => {
  const EURC = "0xeurc00000000000000000000000000000000000001";
  const AERO = "0xaero00000000000000000000000000000000000002";
  const WSTETH = "0xwsteth000000000000000000000000000000000003";
  const USDC = "0xusdc00000000000000000000000000000000000004";
  const WETH = "0xweth00000000000000000000000000000000000005";
  const H = (n: number) => `0x${String(n).padStart(64, "3")}`;
  const c = (h: string, a: string, b: string) => ({ strategyHash: h, tokenA: a, tokenB: b });

  test("shared EURC groups both positions together", () => {
    const { group, dominant } = pickGroup(
      [c(H(1), EURC, AERO), c(H(2), EURC, WSTETH)],
      3,
    );
    expect(dominant).toBe(EURC.toLowerCase());
    expect(group.map((x) => x.strategyHash)).toEqual([H(1), H(2)]);
  });

  test("wstETH and WETH are different contracts, never conflated", () => {
    const ranked = scoreReplacementPairs(
      [{ tokens: [{ address: USDC }, { address: WETH }], apy: 25 }],
      [{ token: WSTETH, usd: 10 }],
    );
    expect(ranked[0].overlapShare).toBe(0);
  });

  test("correlated top wins over raw APY", () => {
    // holdings: EURC 10 + AERO 10 + wstETH 10 = 30
    const holdings = [
      { token: EURC, usd: 10 },
      { token: AERO, usd: 10 },
      { token: WSTETH, usd: 10 },
    ];
    const tops = [
      { tokens: [{ address: USDC }, { address: WETH }], apy: 25 },
      { tokens: [{ address: USDC }, { address: AERO }], apy: 40 },
    ];
    const ranked = scoreReplacementPairs(tops, holdings);
    // USDC/AERO: 40 * (0.5 + 0.5 * 10/30) = 26.67 > USDC/WETH: 25 * 0.5 = 12.5
    expect(ranked[0].tokenB).toBe(AERO.toLowerCase());
    expect(ranked[0].score).toBeCloseTo(26.67, 1);
  });

  test("maxSize splits one group into two rotations", () => {
    const { group } = pickGroup(
      [c(H(1), EURC, AERO), c(H(2), EURC, WSTETH)],
      1,
    );
    expect(group.length).toBe(1);
  });
});

describe("pickTopPairs", () => {
  const r = (a: string, b: string, score: number) => ({
    tokenA: a, tokenB: b, apy: 10, overlapShare: 0, score,
  });
  const A = "0xaa";
  const B = "0xbb";
  const C = "0xcc";
  test("two good tops both deploy", () => {
    const out = pickTopPairs([r(A, B, 30), r(B, C, 26.67), r(A, C, 12.5)], 3, 0.5);
    expect(out.length).toBe(2);
  });
  test("lone good top deploys alone", () => {
    const out = pickTopPairs([r(A, B, 30), r(B, C, 5)], 3, 0.5);
    expect(out.length).toBe(1);
  });
  test("cap respected", () => {
    const out = pickTopPairs([r(A, B, 30), r(B, C, 29), r(A, C, 28)], 2, 0.5);
    expect(out.length).toBe(2);
  });
  test("empty and non-positive safe", () => {
    expect(pickTopPairs([], 3, 0.5)).toEqual([]);
    expect(pickTopPairs([r(A, B, 0)], 3, 0.5)).toEqual([]);
  });
});

// ── misc ────────────────────────────────────────────────────────
describe("ageHoursSince", () => {
  test("unix seconds need x1000 (documents the gotcha, not the fix)", () => {
    // 1789004381 seconds; raw new Date() would read 1970
    expect(new Date(1789004381).getFullYear()).toBe(1970);
    expect(ageHoursSince(new Date(1789004381 * 1000).toISOString())).not.toBe(null);
  });
  test("garbage returns null", () => {
    expect(ageHoursSince(null)).toBe(null);
    expect(ageHoursSince("not-a-date")).toBe(null);
  });
});
