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

export async function fetchTopPositions(
  chainIds: number[],
  limit: number,
  sortBy: "apy" | "volume",
  apiKey: string,
): Promise<TopPosition[]> {

  const isSingleChainFilter = chainIds.length === 1;
  const tryLeaderboard = async (): Promise<TopPosition[] | null> => {
    if (isSingleChainFilter) return null;
    try {
      const lbRes = await fetch(`${AQUA_BASE}/leaderboard/makers?limit=${limit * 2}`, {
        headers: { ...aquaHeaders(apiKey) },
      });
      if (!lbRes.ok) return null;
      const lb = await lbRes.json();
      const makers: any[] = lb.items ?? []
      if (makers.length === 0) return null;
      const out: TopPosition[] = [];
      for (const m of makers.slice(0, limit * 3)) {
        const maker = m.maker as string;
        if (!maker) continue;
        try {
          const qs = new URLSearchParams({ limit: "10" });
          chainIds.forEach((id) => qs.append("chainIds", String(id)));
          const stratRes = await fetch(`${AQUA_BASE}/strategies/makers/${maker}?${qs.toString()}`, {
            headers: { ...aquaHeaders(apiKey) },
          });
          if (!stratRes.ok) continue;
          const sj = await stratRes.json();
          const strats: any[] = sj.items ?? [];
          if (strats.length === 0) continue;
          let best = strats[0];
          let bestApy = -1;
          for (const s of strats) {
            const apy = s.performance?.fees?.last30d?.apy ?? s.performance?.fees?.total?.apy ?? -1;
            const v = apy ?? -1;
            if (v > bestApy) {
              bestApy = v;
              best = s;
            }
          }
          const strat = best;
          const cid = strat.chainId as number;
          const app = strat.app as string;
          const hash = strat.strategyHash as string;
          let overview: any = strat;
          try {
            const ovRes = await fetch(`${AQUA_BASE}/strategies/overview/${cid}/${maker}/${app}/${hash}`, {
              headers: { ...aquaHeaders(apiKey) },
            });
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
        const apy = p.performance?.fees?.last24h?.apy ?? p.performance?.fees?.last7d?.apy ?? p.performance?.fees?.last30d?.apy;
        const vol = p.performance?.volume?.last24h?.usd ?? p.performance?.volume?.last7d?.usd ?? p.performance?.volume?.last30d?.usd;
        return (apy !== null && apy !== undefined && apy > 0) || (vol !== null && vol !== undefined && vol > 0);
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

  const res = await fetch(
    `${AQUA_BASE}/strategies/opened?${params.toString()}`,
    {
      headers: {
        ...aquaHeaders(apiKey),
      },
    },
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
          const overviewRes = await fetch(
            `${AQUA_BASE}/strategies/overview/${chainId}/${maker}/${app}/${strategyHash}`,
            {
              headers: {
                ...aquaHeaders(apiKey),
              },
            },
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

  return distinct.slice(0, limit);
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
