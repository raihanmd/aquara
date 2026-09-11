export const AQUA_BASE = "https://api.1inch.com/aqua/v1.0";

export function aquaHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, accept: "application/json" };
}

export interface TopPositionToken {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  currentBalance?: { raw: string; usd?: number | null } | string;
  initialBalance?: { raw: string; usd?: number | null } | string;
  wallet?: { balance?: { raw: string; usd?: number | null } | null };
}

export interface TopPositionPerformance {
  fees: {
    last24h: {
      apy: number | null;
      usd?: number;
    };
    last7d: {
      apy: number | null;
      usd?: number;
    };
    last30d: {
      apy: number | null;
      usd?: number;
    };
  };
  volume: {
    last24h: {
      usd: number | null;
    };
    last7d: {
      usd: number | null;
    };
    last30d: {
      usd: number | null;
    };
  };
}

export interface TopPosition {
  chainId: number;
  maker: string;
  app: string;
  strategyHash: string;
  strategyBytes: string;
  openedAt: number;
  tokens: TopPositionToken[];
  performance: TopPositionPerformance | null;
  classification: string | Record<string, unknown> | null;
  priceRange: {
    lower?: string | number | null;
    upper?: string | number | null;
    lowerTick?: number | null;
    upperTick?: number | null;
  } | null;
}

export interface UseTopPositionsParams {
  chainIds: number[];
  limit?: number;
  sortBy?: "apy" | "volume";
}

export function getApiKey(): string {
  const key = process.env.ONEINCH_API_KEY || process.env.NEXT_PUBLIC_1INCH_API_KEY;
  if (!key) throw new Error("ONEINCH_API_KEY missing (server)");
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Dev-only pacing: one shared 1inch key serves web, rotator and scripts, and
// a single dashboard load fans out dozens of calls. In non-prod every
// upstream call waits its turn with a gap, so bursts never form. Prod gap is
// zero (latency matters there; retries still apply). Tune: AQUA_DEV_GAP_MS.
const DEV_GAP_MS =
  process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test"
    ? Math.max(0, Number(process.env.AQUA_DEV_GAP_MS ?? 300) || 300)
    : 0;
let paceTail: Promise<void> = Promise.resolve();
export async function pace(): Promise<void> {
  if (DEV_GAP_MS <= 0) return;
  const prev = paceTail;
  let release!: () => void;
  paceTail = new Promise((r) => (release = r));
  try {
    await prev;
    await sleep(DEV_GAP_MS);
  } finally {
    release();
  }
}

/**
 * Upstream fetch with 429/502/503-aware retries. 1inch throttles hard;
 * without backoff a single dashboard load (dozens of fan-out calls) burns
 * the key quota and everything 429s together.
 */
async function fetchUpstream(url: string, apiKey: string, tries = 3): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    await pace();
    if (attempt > 0) await sleep(1000 * attempt);
    try {
      const res = await fetch(url, { headers: { ...aquaHeaders(apiKey) } });
      if (res.status === 502 || res.status === 503 || res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 30) {
          await sleep(retryAfter * 1000);
        }
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("upstream fetch failed");
}

// In-flight dedupe: concurrent identical tops requests (StrictMode double
// mount, dashboard + signal + rotator at once) share one upstream burst.
const topsInflight = new Map<string, Promise<TopPosition[]>>();

/**
 * Live positions for a maker with retries. The 1inch API flakes with
 * transient 502/503/429s; a single attempt turns the whole signal/rotator
 * run empty, so retry with backoff before giving up.
 */
export async function fetchMakerPositions(
  maker: string,
  apiKey: string,
  limit = 50,
  chainIds: number[] = [8453],
): Promise<unknown[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  (chainIds.length > 0 ? chainIds : [8453]).forEach((id) =>
    qs.append("chainIds", String(id)),
  );
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await pace();
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const res = await fetch(`${AQUA_BASE}/strategies/makers/${maker}?${qs}`, {
        headers: aquaHeaders(apiKey),
      });
      if (res.status === 502 || res.status === 503 || res.status === 429) continue;
      if (!res.ok) throw new Error(`Aqua API ${res.status}`);
      const json = await res.json();
      const items = Array.isArray(json) ? json : (json.items ?? []);
      if (Array.isArray(items)) return items;
      throw new Error("bad positions shape");
    } catch (e) {
      // Non-retryable HTTP errors fail fast; only flaky statuses + network
      // errors consume retry budget.
      if (e instanceof Error && e.message.startsWith("Aqua API ")) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("positions fetch failed");
}

export async function fetchTopPositions(
  chainIds: number[],
  limit: number,
  sortBy: "apy" | "volume",
  apiKey: string,
): Promise<TopPosition[]> {
  const key = `tops|${[...chainIds].sort().join(",")}|${limit}|${sortBy}`;
  const inflight = topsInflight.get(key);
  if (inflight) return inflight;
  const p = fetchTopPositionsInner(chainIds, limit, sortBy, apiKey).finally(() => {
    topsInflight.delete(key);
  });
  topsInflight.set(key, p);
  return p;
}

async function fetchTopPositionsInner(
  chainIds: number[],
  limit: number,
  sortBy: "apy" | "volume",
  apiKey: string,
): Promise<TopPosition[]> {

  const tryLeaderboard = async (): Promise<TopPosition[] | null> => {
    // No chain guard: the leaderboard is global (no chainIds param), per-maker
    // strategies calls below still filter by chainIds. sortBy maps 1:1 to the
    // leaderboard columns; period=7d is the default window. Falls back to
    // recently-opened on !ok.
    try {
      const lbQs = new URLSearchParams({
        limit: String(limit * 2),
        sortBy: sortBy === "apy" ? "apy" : "volume",
        period: "7d",
      });
      const lbRes = await fetchUpstream(`${AQUA_BASE}/leaderboard/makers?${lbQs}`, apiKey);
      if (!lbRes.ok) return null;
      const lb = await lbRes.json();
      const makers: any[] = lb.items ?? []
      if (makers.length === 0) return null;
      const out: TopPosition[] = [];
      // Cap makers processed: the leaderboard is pre-ranked, so the first
      // (limit + 2) makers suffice. Was limit * 3 with 2 calls each (37+
      // requests per refresh) - the main quota burner.
      for (const m of makers.slice(0, limit + 2)) {
        const maker = m.maker as string;
        if (!maker) continue;
        // Makers with no open strategies only burn quota: skip before fetching.
        if (typeof m.strategies?.open === "number" && m.strategies.open === 0) continue;
        try {
          const qs = new URLSearchParams({ limit: "10" });
          chainIds.forEach((id) => qs.append("chainIds", String(id)));
          const stratRes = await fetchUpstream(`${AQUA_BASE}/strategies/makers/${maker}?${qs.toString()}`, apiKey);
          if (!stratRes.ok) continue;
          const sj = await stratRes.json();
          const strats: any[] = (sj.items ?? []).filter(
            (s: any) => chainIds.length === 0 || chainIds.includes(Number(s.chainId)),
          );
          if (strats.length === 0) continue;
          // Best strategy follows the requested sort: volume-ranked makers
          // need their highest-volume strategy, not highest-APY one.
          const metric = (s: any): number => {
            if (sortBy === "volume") {
              const v = s.performance?.volume?.last24h?.usd ?? s.performance?.volume?.last7d?.usd ?? s.performance?.volume?.last30d?.usd;
              return typeof v === "number" ? v : -1;
            }
            const apy = s.performance?.fees?.last30d?.apy ?? s.performance?.fees?.total?.apy ?? -1;
            return apy ?? -1;
          };
          let best = strats[0];
          let bestScore = -1;
          for (const s of strats) {
            const v = metric(s);
            if (v > bestScore) {
              bestScore = v;
              best = s;
            }
          }
          const strat = best;
          const cid = strat.chainId as number;
          const app = strat.app as string;
          const hash = strat.strategyHash as string;
          let overview: any = strat;
          try {
            const ovRes = await fetchUpstream(`${AQUA_BASE}/strategies/overview/${cid}/${maker}/${app}/${hash}`, apiKey, 2);
            if (ovRes.ok) overview = await ovRes.json();
          } catch {}
          let perf = (overview.performance as TopPositionPerformance) ?? (strat.performance as TopPositionPerformance) ?? null;
          const mergedTokens = (overview.tokens as unknown[] | undefined)?.map((t: any) => ({
            address: t.address,
            symbol: t.meta?.symbol ?? t.symbol,
            name: t.meta?.name ?? t.name,
            decimals: t.meta?.decimals ?? t.decimals,
            logoURI: t.meta?.logoURI ?? t.logoURI,
            currentBalance: t.currentBalance,
            initialBalance: t.initialBalance,
            wallet: t.wallet,
          })) as TopPositionToken[] | undefined;
          const stratApy = perf?.fees?.last24h?.apy ?? perf?.fees?.last7d?.apy ?? perf?.fees?.last30d?.apy;
          const lbApy = (m as any).apy?.percent;
          const stratVol = perf?.volume?.last24h?.usd ?? perf?.volume?.last7d?.usd ?? perf?.volume?.last30d?.usd;
          const lbVol = (m as any).volume?.usd;
          const isZeroOrNull = (v: any) => v === null || v === undefined || v === 0;
          if (isZeroOrNull(stratApy) && lbApy) {
            perf = {
              fees: {
                last24h: { apy: lbApy, usd: perf?.fees?.last24h?.usd ?? perf?.fees?.last7d?.usd ?? perf?.fees?.last30d?.usd ?? null },
                last7d: { apy: lbApy, usd: perf?.fees?.last7d?.usd ?? perf?.fees?.last30d?.usd ?? null },
                last30d: { apy: lbApy, usd: perf?.fees?.last30d?.usd ?? null },
              },
              volume: {
                last24h: { usd: isZeroOrNull(stratVol) ? lbVol : stratVol },
                last7d: { usd: isZeroOrNull(stratVol) ? lbVol : stratVol },
                last30d: { usd: isZeroOrNull(stratVol) ? lbVol : stratVol },
              },
            } as TopPositionPerformance;
          } else if (isZeroOrNull(stratVol) && lbVol) {
            perf = {
              fees: {
                last24h: { apy: stratApy ?? null, usd: perf?.fees?.last24h?.usd ?? perf?.fees?.last7d?.usd ?? perf?.fees?.last30d?.usd ?? null },
                last7d: { apy: stratApy ?? null, usd: perf?.fees?.last7d?.usd ?? perf?.fees?.last30d?.usd ?? null },
                last30d: { apy: stratApy ?? null, usd: perf?.fees?.last30d?.usd ?? null },
              },
              volume: {
                last24h: { usd: lbVol },
                last7d: { usd: lbVol },
                last30d: { usd: lbVol },
              },
            } as TopPositionPerformance;
          }
          out.push(
            normalizePosition({
              chainId: cid,
              maker,
              app,
              strategyHash: hash,
              strategyBytes: strat.strategyBytes ?? hash,
              openedAt: strat.openedAt,
              tokens: mergedTokens ?? strat.tokens,
              performance: isPerformance(perf) ? perf : null,
              classification: strat.classification ?? overview.classification,
              priceRange: overview.priceRange ?? strat.priceRange,
            }),
          );
          if (out.length >= limit) break;
        } catch {}
      }
      const seenLb = new Set<string>();
      const distinctOut = out.filter((p) => {
        const t0 = p.tokens[0]?.symbol ?? p.tokens[0]?.address ?? "";
        const t1 = p.tokens[1]?.symbol ?? p.tokens[1]?.address ?? "";
        const fee = (p.classification as any)?.feePercent ?? "";
        const key = `${t0}-${t1}-${fee}-${p.chainId}`;
        if (seenLb.has(key)) return false;
        seenLb.add(key);
        return true;
      });
      distinctOut.sort((a, b) => {
        if (sortBy === "apy") {
          const av = a.performance?.fees?.last24h?.apy ?? a.performance?.fees?.last7d?.apy ?? a.performance?.fees?.last30d?.apy ?? -1;
          const bv = b.performance?.fees?.last24h?.apy ?? b.performance?.fees?.last7d?.apy ?? b.performance?.fees?.last30d?.apy ?? -1;
          return (bv ?? -1) - (av ?? -1);
        }
        const av = a.performance?.volume?.last24h?.usd ?? a.performance?.volume?.last7d?.usd ?? a.performance?.volume?.last30d?.usd ?? 0;
        const bv = b.performance?.volume?.last24h?.usd ?? b.performance?.volume?.last7d?.usd ?? b.performance?.volume?.last30d?.usd ?? 0;
        return (bv ?? 0) - (av ?? 0);
      });
      const filtered = distinctOut.filter((p) => {
        if (chainIds.length > 0 && !chainIds.includes(Number(p.chainId))) return false;
        const apy = p.performance?.fees?.last24h?.apy ?? p.performance?.fees?.last7d?.apy ?? p.performance?.fees?.last30d?.apy;
        const vol = p.performance?.volume?.last24h?.usd ?? p.performance?.volume?.last7d?.usd ?? p.performance?.volume?.last30d?.usd;
        const hasSignal = (apy !== null && apy !== undefined && apy > 0) || (vol !== null && vol !== undefined && vol > 0);
        if (!hasSignal) return false;
        if (rowSizeUsd(p) > 1e9 && (vol ?? 0) <= 0) return false;
        return true;
      });
      return filtered.length >= 2 ? filtered.slice(0, limit) : null;
    } catch {
      return null;
    }
  };

  const lbTop = await tryLeaderboard();
  if (lbTop && lbTop.length > 0) return lbTop;

  const params = new URLSearchParams({
    limit: String(limit * 3),
    sort: "desc",
  });
  chainIds.forEach((id) => params.append("chainIds", String(id)));

  const res = await fetchUpstream(
    `${AQUA_BASE}/strategies/opened?${params.toString()}`,
    apiKey,
  );

  if (!res.ok) {
    throw new Error(`Aqua API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const items: Record<string, unknown>[] = Array.isArray(json)
    ? json
    : (json.data ?? json.items ?? json.result ?? []);

  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const enriched: TopPosition[] = [];

  for (let i = 0; i < items.length; i += 5) {
    const chunk = items.slice(i, i + 5);
    const results = await Promise.all(
      chunk.map(async (item) => {
        const chainId = item.chainId as number;
        const maker = item.maker as string;
        const app = item.app as string;
        const strategyHash = item.strategyHash as string;

        if (!chainId || !maker || !app || !strategyHash) {
          return normalizePosition(item);
        }

        try {
          const overviewRes = await fetchUpstream(
            `${AQUA_BASE}/strategies/overview/${chainId}/${maker}/${app}/${strategyHash}`,
            apiKey,
            2,
          );

          if (!overviewRes.ok) {
            return normalizePosition(item);
          }

          const overview = await overviewRes.json();
          const performance =
            (overview.performance as TopPositionPerformance) ??
            (overview as TopPositionPerformance) ??
            (item.performance as TopPositionPerformance) ??
            null;

          const mergedTokens = (overview.tokens as unknown[] | undefined)?.map((t: any) => ({
            address: t.address,
            symbol: t.meta?.symbol ?? t.symbol,
            name: t.meta?.name ?? t.name,
            decimals: t.meta?.decimals ?? t.decimals,
            logoURI: t.meta?.logoURI ?? t.logoURI,
            currentBalance: t.currentBalance,
            initialBalance: t.initialBalance,
            wallet: t.wallet,
          })) as TopPositionToken[] | undefined

          return normalizePosition({
            ...item,
            tokens: mergedTokens ?? (item.tokens as TopPositionToken[]),
            performance: isPerformance(performance)
              ? performance
              : (item.performance ?? null),
            classification:
              item.classification ?? overview.classification ?? null,
            priceRange: item.priceRange ?? overview.priceRange ?? null,
          });
        } catch {
          return normalizePosition(item);
        }
      }),
    );
    enriched.push(...results);
  }

  const seenPairs = new Set<string>();
  const distinct = enriched.filter((p) => {
    const t0 = p.tokens[0]?.symbol ?? p.tokens[0]?.address ?? "";
    const t1 = p.tokens[1]?.symbol ?? p.tokens[1]?.address ?? "";
    const fee = (p.classification as any)?.feePercent ?? (p.classification as any)?.fee ?? "";
    const key = `${t0}-${t1}-${fee}-${p.chainId}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    return true;
  });

  distinct.sort((a, b) => {
    if (sortBy === "apy") {
      const aApy = a.performance?.fees?.last24h?.apy ?? a.performance?.fees?.last7d?.apy ?? a.performance?.fees?.last30d?.apy;
      const bApy = b.performance?.fees?.last24h?.apy ?? b.performance?.fees?.last7d?.apy ?? b.performance?.fees?.last30d?.apy;
      const aVal = aApy === null || aApy === undefined ? -1 : aApy;
      const bVal = bApy === null || bApy === undefined ? -1 : bApy;
      return bVal - aVal;
    }
    const aVol = a.performance?.volume?.last24h?.usd ?? a.performance?.volume?.last7d?.usd ?? a.performance?.volume?.last30d?.usd;
    const bVol = b.performance?.volume?.last24h?.usd ?? b.performance?.volume?.last7d?.usd ?? b.performance?.volume?.last30d?.usd;
    const aVal = aVol === null || aVol === undefined ? 0 : aVol;
    const bVal = bVol === null || bVol === undefined ? 0 : bVol;
    return bVal - aVal;
  });

  // Drop dead rows so dust never poses as "top". Enforce the requested
  // chains client-side: upstream ignores chainIds on some endpoints. Also
  // drop absurd whale rows (size over $1B with zero volume/APY): upstream
  // decimals garbage, and showing "$666,542,382M size, $0 volume" destroys
  // trust in the whole panel.
  const alive = distinct.filter((p) => {
    if (chainIds.length > 0 && !chainIds.includes(Number(p.chainId))) return false;
    const apy = p.performance?.fees?.last24h?.apy ?? p.performance?.fees?.last7d?.apy ?? p.performance?.fees?.last30d?.apy;
    const vol = p.performance?.volume?.last24h?.usd ?? p.performance?.volume?.last7d?.usd ?? p.performance?.volume?.last30d?.usd;
    const hasSignal = (apy !== null && apy !== undefined && apy > 0) || (vol !== null && vol !== undefined && vol > 0);
    if (!hasSignal) return false;
    if (rowSizeUsd(p) > 1e9 && (vol ?? 0) <= 0) return false;
    return true;
  });
  return alive.slice(0, limit);
}

function rowSizeUsd(p: TopPosition): number {
  return (p.tokens ?? []).reduce((n, t) => {
    const b = t.currentBalance;
    const u = typeof b === "object" && b !== null ? b.usd : null;
    return n + (typeof u === "number" && Number.isFinite(u) ? u : 0);
  }, 0);
}

function isPerformance(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "fees" in o || "volume" in o;
}

function normalizePosition(raw: Record<string, unknown>): TopPosition {
  const rawTokens = (raw.tokens as any[]) ?? []
  const tokens: TopPositionToken[] = rawTokens.map((t: any) => ({
    address: t.address ?? t.token ?? "",
    symbol: t.symbol ?? t.meta?.symbol,
    name: t.name ?? t.meta?.name,
    decimals: t.decimals ?? t.meta?.decimals,
    logoURI: t.logoURI ?? t.meta?.logoURI,
    currentBalance: t.currentBalance,
    initialBalance: t.initialBalance,
    wallet: t.wallet,
  }))
  return {
    chainId: (raw.chainId as number) ?? 0,
    maker: (raw.maker as string) ?? "",
    app: (raw.app as string) ?? "",
    strategyHash: (raw.strategyHash as string) ?? "",
    strategyBytes:
      (raw.strategyBytes as string) ?? (raw.strategyHash as string) ?? "",
    openedAt: (raw.openedAt as number) ?? (raw.timestamp as number) ?? 0,
    tokens,
    performance: (raw.performance as TopPositionPerformance) ?? null,
    classification:
      (raw.classification as TopPosition["classification"]) ?? null,
    priceRange: (raw.priceRange as TopPosition["priceRange"]) ?? null,
  };
}
