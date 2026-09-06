"use client";

import { useEffect, useState } from "react";

export interface PricePoint {
  timestamp: number;
  token0Price: number;
  token1Price: number;
}

export type Duration = "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR";

const cache = new Map<string, { prices: PricePoint[]; ts: number }>();
const CACHE_TTL = 60_000;

export function usePoolPrices(poolId?: string, duration: Duration = "WEEK") {
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!poolId) return;

    const key = `${poolId}:${duration}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      setPrices(cached.prices);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    fetch(`/api/pool-prices?poolId=${poolId}&duration=${duration}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const data: PricePoint[] = json.data ?? [];
        cache.set(key, { prices: data, ts: Date.now() });
        setPrices(data);
      })
      .catch(() => {
        if (!cancelled) setPrices([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [poolId, duration]);

  return { prices, isLoading };
}
