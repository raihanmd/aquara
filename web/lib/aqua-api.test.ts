import { describe, expect, test, afterEach } from "bun:test";
import { fetchMakerPositions, fetchTopPositions } from "./aqua-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function seq(statuses: Array<number | { status: number; body: unknown }>) {
  let i = 0;
  globalThis.fetch = (async () => {
    const s = statuses[Math.min(i++, statuses.length - 1)];
    const status = typeof s === "number" ? s : s.status;
    const body = typeof s === "number" ? { items: [] } : s.body;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("fetchMakerPositions", () => {
  test("retries transient 502s then succeeds", async () => {
    seq([502, 503, { status: 200, body: { items: [{ strategyHash: "0xabc" }] } }]);
    const out = await fetchMakerPositions("0xmaker", "key", 20);
    expect(out).toEqual([{ strategyHash: "0xabc" }]);
  });
  test("429 is retried, not fatal", async () => {
    seq([429, { status: 200, body: [] }]);
    expect(await fetchMakerPositions("0xmaker", "key")).toEqual([]);
  });
  test("401 fails fast without 4 attempts", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}", { status: 401 });
    }) as typeof fetch;
    await expect(fetchMakerPositions("0xmaker", "key")).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test("bare array shape accepted", async () => {
    seq([{ status: 200, body: [{ strategyHash: "0x1" }] }]);
    expect(await fetchMakerPositions("0xmaker", "key")).toEqual([{ strategyHash: "0x1" }]);
  });
  test("persistent 502 throws after retries", async () => {
    seq([502, 502, 502, 502, 502]);
    await expect(fetchMakerPositions("0xmaker", "key")).rejects.toThrow();
  }, { timeout: 20000 });
});

describe("fetchTopPositions", () => {
  const strat = (hash: string, apy: number | null, vol: number | null, sym = "A") => ({
    chainId: 8453,
    maker: "0xmaker",
    app: "0xapp",
    strategyHash: hash,
    strategyBytes: "0x00",
    openedAt: 1,
    tokens: [
      { address: `0x${sym.toLowerCase()}`, symbol: sym, currentBalance: { raw: "1", usd: 1 } },
      { address: "0xb", symbol: "B", currentBalance: { raw: "1", usd: 1 } },
    ],
    performance: {
      fees: { last24h: { apy }, last7d: { apy: null }, last30d: { apy: null } },
      volume: { last24h: { usd: vol }, last7d: { usd: null }, last30d: { usd: null } },
    },
    classification: null,
    priceRange: null,
  });

  test("leaderboard path runs even for single-chain filter", async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/leaderboard/makers")) {
        return new Response(
          JSON.stringify({ items: [{ maker: "0xmaker" }, { maker: "0xmaker2" }] }),
          { status: 200 },
        );
      }
      if (u.includes("/strategies/makers/0xmaker2")) {
        return new Response(JSON.stringify({ items: [strat("0xh2", 40, 90, "C")] }), { status: 200 });
      }
      if (u.includes("/strategies/makers/")) {
        return new Response(JSON.stringify({ items: [strat("0xh", 50, 100)] }), { status: 200 });
      }
      if (u.includes("/strategies/overview/")) {
        const h = u.includes("0xh2") ? strat("0xh2", 40, 90, "C") : strat("0xh", 50, 100);
        return new Response(JSON.stringify(h), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    const out = await fetchTopPositions([8453], 6, "apy", "key");
    expect(out.length).toBe(2);
    expect(out[0].strategyHash).toBe("0xh");
  });

  test("wrong-chain rows are dropped even when upstream ignores chainIds", async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/leaderboard/")) return new Response("{}", { status: 404 });
      if (u.includes("/strategies/opened")) {
        return new Response(
          JSON.stringify([
            { ...strat("0xeth", 99, 99), chainId: 1 },
            { ...strat("0xbase", 10, 10), chainId: 8453 },
          ]),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const out = await fetchTopPositions([8453], 6, "apy", "key");
    expect(out.every((p) => p.chainId === 8453)).toBe(true);
    expect(out.length).toBe(1);
  });

  test("absurd whale row with zero volume is dropped", async () => {
    const whale = {
      ...strat("0xwhale", null, null),
      tokens: [
        { address: "0xa", symbol: "A", currentBalance: { raw: "1", usd: 2e9 } },
        { address: "0xb", symbol: "B", currentBalance: { raw: "1", usd: 1 } },
      ],
    };
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/leaderboard/")) return new Response("{}", { status: 404 });
      if (u.includes("/strategies/opened")) {
        return new Response(JSON.stringify([whale]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    expect(await fetchTopPositions([8453], 6, "apy", "key")).toEqual([]);
  });

  test("concurrent identical calls share one upstream burst", async () => {
    let hits = 0;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/leaderboard/makers")) {
        hits++;
        await new Promise((r) => setTimeout(r, 50));
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (u.includes("/strategies/opened")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    await Promise.all([
      fetchTopPositions([8453], 6, "apy", "key"),
      fetchTopPositions([8453], 6, "apy", "key"),
    ]);
    expect(hits).toBe(1);
  });

  test("makers with zero open strategies are skipped before fetching", async () => {
    const fetched: string[] = [];
    const mk = (h: string, sym: string) => ({
      ...strat(h, 50, 100),
      tokens: [
        { address: `0x${sym.toLowerCase()}`, symbol: sym, currentBalance: { raw: "1", usd: 1 } },
        { address: "0xb", symbol: "B", currentBalance: { raw: "1", usd: 1 } },
      ],
    });
    const byMaker: Record<string, unknown[]> = {
      "0xmaker1": [mk("0xh1", "A")],
      "0xmaker2": [mk("0xh2", "C")],
    };
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/leaderboard/makers")) {
        return new Response(
          JSON.stringify({
            items: [
              { maker: "0xdead", strategies: { open: 0 } },
              { maker: "0xmaker1" },
              { maker: "0xmaker2" },
            ],
          }),
          { status: 200 },
        );
      }
      if (u.includes("/strategies/makers/")) {
        fetched.push(u);
        const key = ["0xmaker1", "0xmaker2"].find((k) => u.includes(k)) ?? "0xmaker1";
        return new Response(JSON.stringify({ items: byMaker[key] }), { status: 200 });
      }
      if (u.includes("/strategies/overview/")) {
        const all = [...byMaker["0xmaker1"], ...byMaker["0xmaker2"]];
        const hit = all.find((s: any) => u.includes(s.strategyHash)) ?? all[0];
        return new Response(JSON.stringify(hit), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    const out = await fetchTopPositions([8453], 6, "apy", "key");
    expect(fetched.some((u) => u.includes("0xdead"))).toBe(false);
    expect(out.length).toBe(2);
  });

  test("volume sort picks highest-volume strategy per maker", async () => {
    const s1 = { ...strat("0xlowvol", 99, 1), tokens: [{ address: "0xa", symbol: "A", currentBalance: { raw: "1", usd: 1 } }, { address: "0xb", symbol: "B", currentBalance: { raw: "1", usd: 1 } }] };
    const s2 = { ...strat("0xhighvol", 1, 999), tokens: [{ address: "0xc", symbol: "C", currentBalance: { raw: "1", usd: 1 } }, { address: "0xd", symbol: "D", currentBalance: { raw: "1", usd: 1 } }] };
    const s3 = { ...strat("0xother", 50, 500), tokens: [{ address: "0xe", symbol: "E", currentBalance: { raw: "1", usd: 1 } }, { address: "0xf", symbol: "F", currentBalance: { raw: "1", usd: 1 } }] };
    const byUrl = (u: string) => (u.includes("/strategies/makers/0xmaker2") ? [s3] : [s1, s2]);
    const byHash = (u: string) => (u.includes("0xhighvol") ? s2 : u.includes("0xother") ? s3 : s1);
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/leaderboard/makers")) {
        return new Response(JSON.stringify({ items: [{ maker: "0xmaker" }, { maker: "0xmaker2" }] }), { status: 200 });
      }
      if (u.includes("/strategies/makers/")) {
        return new Response(JSON.stringify({ items: byUrl(u) }), { status: 200 });
      }
      if (u.includes("/strategies/overview/")) {
        return new Response(JSON.stringify(byHash(u)), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    const out = await fetchTopPositions([8453], 6, "volume", "key");
    expect(out[0].strategyHash).toBe("0xhighvol");
  });

  test("dead rows never pose as top", async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/leaderboard/")) return new Response("{}", { status: 404 });
      if (u.includes("/strategies/opened")) {
        return new Response(
          JSON.stringify([strat("0xdead", null, null), strat("0xdead2", 0, 0)]),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const out = await fetchTopPositions([8453], 6, "apy", "key");
    expect(out).toEqual([]);
  });
});
