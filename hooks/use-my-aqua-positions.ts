"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";

// ── Demo address (user's deployed ship on Base) ──────────────────────────
export const DEMO_ADDRESS =
  "0xCbAfD2B1c1309b1701E9ef7e4d38C93425A6b61A" as const;

// ── Types ─────────────────────────────────────────────────────────────────
export interface AquaToken {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  currentBalance?: { raw: string; usd?: number | null } | string;
  initialBalance?: { raw: string; usd?: number | null } | string;
  walletBalance?: { raw: string; usd?: number | null };
  meta?: {
    symbol?: string;
    name?: string;
    decimals?: number;
    logoURI?: string;
  };
}

export interface EnrichedAquaPosition {
  strategyHash: string;
  strategyBytes: string;
  chainId: number;
  app: string;
  maker: string;
  tokens: AquaToken[];
  status: "inRange" | "outOfRange";
  isOutOfRange: boolean;
  classification: Record<string, unknown> | string | null;
  priceRange: {
    lower?: string | number | null;
    upper?: string | number | null;
    lowerTick?: number | null;
    upperTick?: number | null;
  } | null;
  performance: {
    fees?: {
      last24h?: { apy: number | null; usd?: number | null };
      last7d?: { apy: number | null; usd?: number | null };
      last30d?: { apy: number | null; usd?: number | null };
      total?: { apy: number | null; usd?: number | null };
    };
    volume?: {
      last24h?: { usd: number | null };
      last7d?: { usd: number | null };
      last30d?: { usd: number | null };
    };
  } | null;
  openedAt?: number;
  // Raw for debugging
  _raw?: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Determine if position is Out Of Range (OOR).
 * OOR if classification.state === 'illiquidity' OR any token currentBalance is 0.
 */
export function isAquaOutOfRange(
  classification: EnrichedAquaPosition["classification"],
  tokens: AquaToken[],
): boolean {
  // Check classification.state === 'illiquidity'
  if (classification && typeof classification === "object") {
    const state = (classification as Record<string, unknown>).state;
    if (state === "illiquidity") return true;
    // Also handle nested classification like { status: 'illiquidity' }
    const status = (classification as Record<string, unknown>).status;
    if (status === "illiquidity") return true;
  }
  if (typeof classification === "string" && classification === "illiquidity") {
    return true;
  }

  for (const t of tokens) {
    const bal: any = t.currentBalance;
    const raw = typeof bal === "object" && bal !== null ? bal.raw : bal;
    if (raw !== undefined && raw !== null) {
      const balStr = String(raw).trim();
      if (balStr === "0" || balStr === "0x0" || balStr === "") return true;
      const num = Number(balStr);
      if (!isNaN(num) && num === 0) return true;
    }
  }

  return false;
}

function normalizeToken(raw: Record<string, unknown>): AquaToken {
  const meta = (raw.meta as Record<string, unknown> | undefined) ?? undefined;
  return {
    address: (raw.address as string) ?? (raw.token as string) ?? "",
    symbol: (raw.symbol as string) ?? (meta?.symbol as string | undefined),
    name: (raw.name as string) ?? (meta?.name as string | undefined),
    decimals:
      (raw.decimals as number) ?? (meta?.decimals as number | undefined),
    logoURI: (raw.logoURI as string) ?? (meta?.logoURI as string | undefined),
    currentBalance: raw.currentBalance as any,
    initialBalance: raw.initialBalance as any,
    walletBalance: (raw.wallet as any)?.balance ?? undefined,
    meta: meta
      ? {
          symbol: meta.symbol as string | undefined,
          name: meta.name as string | undefined,
          decimals: meta.decimals as number | undefined,
          logoURI: meta.logoURI as string | undefined,
        }
      : undefined,
  };
}

function normalizeAquaPosition(
  raw: Record<string, unknown>,
): EnrichedAquaPosition {
  const tokensRaw = (raw.tokens as Record<string, unknown>[] | undefined) ?? [];
  const tokens = tokensRaw.map((t) =>
    normalizeToken(t as Record<string, unknown>),
  );
  const classification =
    (raw.classification as EnrichedAquaPosition["classification"]) ?? null;
  const oor = isAquaOutOfRange(classification, tokens);

  return {
    strategyHash: (raw.strategyHash as string) ?? "",
    strategyBytes:
      (raw.strategyBytes as string) ?? (raw.strategyHash as string) ?? "",
    chainId: (raw.chainId as number) ?? 8453,
    app: (raw.app as string) ?? "",
    maker: (raw.maker as string) ?? "",
    tokens,
    status: oor ? "outOfRange" : "inRange",
    isOutOfRange: oor,
    classification,
    priceRange: (raw.priceRange as EnrichedAquaPosition["priceRange"]) ?? null,
    performance:
      (raw.performance as EnrichedAquaPosition["performance"]) ?? null,
    openedAt:
      (raw.openedAt as number) ?? (raw.timestamp as number) ?? undefined,
    _raw: raw,
  };
}

// ── Fetch via same-origin relayer (key stays server-side) ───────────────────
async function fetchAquaPositionsForMaker(
  maker: string,
): Promise<EnrichedAquaPosition[]> {
  const params = new URLSearchParams({ maker, limit: "20", chainIds: "8453" });

  const res = await fetch(`/api/aqua/positions?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`Positions API error: ${res.status}`);
  }

  const json = await res.json();
  const items: Record<string, unknown>[] = Array.isArray(json.items)
    ? json.items
    : [];

  if (items.length === 0) return [];

  return items.map((item) =>
    normalizeAquaPosition(item as Record<string, unknown>),
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────

/**
 * CRE rebalance reference - batch pattern for ship/dock:
 *   batch [approve(token0, Aqua, amount), approve(token1, Aqua, amount), ship(app, strategy, tokens, amounts)]
 * The Aqua ship requires both tokens approved to Aqua (0x1111113ccf1426a8e30e2bff5e005d929bf6a90a)
 * before calling ship. For CRE, encode as a single BatchedCall with 3 calls:
 *   1. ERC20 approve token0 -> Aqua
 *   2. ERC20 approve token1 -> Aqua
 *   3. Aqua ship(app, strategyBytes, tokens[], amounts[])
 * Dock is similar: dock(app, strategyHash) after withdrawing.
 */

export function useMyAquaPositions() {
  const { address } = useAccount();
  const [positions, setPositions] = useState<EnrichedAquaPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [effectiveMaker, setEffectiveMaker] = useState<string | null>(null);

  const fetchPositions = useCallback(async (maker: string) => {
    return fetchAquaPositionsForMaker(maker);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!address) {
        setPositions([]);
        setEffectiveMaker(null);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const walletPositions = await fetchPositions(address);
        if (cancelled) return;
        setPositions(walletPositions);
        setEffectiveMaker(address);
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Failed to fetch Aqua positions";
        setError(msg);
        console.error("[useMyAquaPositions]", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [address, fetchPositions]);

  const refresh = useCallback(async () => {
    if (!address) {
      setPositions([]);
      setEffectiveMaker(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const walletPositions = await fetchPositions(address);
      setPositions(walletPositions);
      setEffectiveMaker(address);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to fetch Aqua positions";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [address, fetchPositions]);

  return {
    positions,
    isLoading,
    error,
    effectiveMaker,
    refresh,
  };
}
