import { describe, expect, test } from "bun:test";
import { checkSanity } from "./oneinch-quote.ts";

describe("checkSanity", () => {
  const aeroUsdc = { srcUsd: 0.576, dstUsd: 1.0, srcDec: 18, dstDec: 6 };
  test("real swap passes (14% price-feed variance tolerated)", () => {
    // Observed live: 0.6439 AERO -> 317993 USDC against a $0.576 feed.
    expect(
      checkSanity(317993n, 643870397844126131n, aeroUsdc),
    ).toBe(null);
  });
  test("near-miss quote passes (15% inside tolerance)", () => {
    // Observed live: $0.47 USDC -> 0.9456 AERO against a $0.576 feed.
    // Miscounted as a 1Mx glitch during debugging (raw digit miscount);
    // the gate correctly passes it, and the test pins that behavior.
    expect(
      checkSanity(945584217929559988n, 472217n, {
        srcUsd: 1.0,
        dstUsd: 0.576,
        srcDec: 6,
        dstDec: 18,
      }),
    ).toBe(null);
  });
  test("truly off-market quote rejected (100x)", () => {
    expect(
      checkSanity(94558421792955998800n, 472217n, {
        srcUsd: 1.0,
        dstUsd: 0.576,
        srcDec: 6,
        dstDec: 18,
      }),
    ).not.toBe(null);
  });
  test("missing data fails open, never blocks", () => {
    expect(checkSanity(1n, 1n)).toBe(null);
    expect(
      checkSanity(1n, 1n, { srcUsd: 0, dstUsd: 1, srcDec: 18, dstDec: 6 }),
    ).toBe(null);
  });
});
