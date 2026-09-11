"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";

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
  status: "inRange" | "outOfRange" | "illiquid";
  isOutOfRange: boolean;
  isIlliquid: boolean;
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

// Helpers

export function isAquaIlliquid(
  classification: EnrichedAquaPosition["classification"],
): boolean {
  if (classification && typeof classification === "object") {
    const state = (classification as Record<string, unknown>).state;
    if (state === "illiquidity") return true;
    const status = (classification as Record<string, unknown>).status;
    if (status === "illiquidity") return true;
  }
  return classification === "illiquidity";
}

/**
 * Determine if position is Out Of Range (OOR).
 * OOR here means empty (no side has any balance). Illiquidity is tracked
 * separately via isAquaIlliquid - an illiquid position may still be in range.
 * Single-sided positions (one side funded) are valid and count as in-range.
 */
export function isAquaOutOfRange(
  _classification: EnrichedAquaPosition["classification"],
  tokens: AquaToken[],
): boolean {
  let anyKnown = false;
  let anyFunded = false;
  for (const t of tokens) {
    const bal: any = t.currentBalance;
    const raw = typeof bal === "object" && bal !== null ? bal.raw : bal;
    if (raw === undefined || raw === null) continue;
    const balStr = String(raw).trim();
    if (balStr === "" || balStr === "0x") continue;
    anyKnown = true;
    const num = Number(balStr);
    if (
      (!isNaN(num) && num > 0) ||
      (isNaN(num) && balStr !== "0" && balStr !== "0x0")
    ) {
      anyFunded = true;
      continue;
    }
    const ib: any = (t as any)?.initialBalance;
    const iraw = ib && typeof ib === "object" ? ib.raw : ib;
    if (iraw === undefined || iraw === null) continue;
    const inum = Number(String(iraw).trim());
    if (!isNaN(inum) && inum > 0) return true;
  }

  return anyKnown && !anyFunded;
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
  const illiquid = isAquaIlliquid(classification);

  return {
    strategyHash: (raw.strategyHash as string) ?? "",
    strategyBytes:
      (raw.strategyBytes as string) ?? (raw.strategyHash as string) ?? "",
    chainId: (raw.chainId as number) ?? 8453,
    app: (raw.app as string) ?? "",
    maker: (raw.maker as string) ?? "",
    tokens,
    status: illiquid ? "illiquid" : oor ? "outOfRange" : "inRange",
    isOutOfRange: oor,
    isIlliquid: illiquid,
    classification,
    priceRange: (raw.priceRange as EnrichedAquaPosition["priceRange"]) ?? null,
    performance:
      (raw.performance as EnrichedAquaPosition["performance"]) ?? null,
    openedAt:
      (raw.openedAt as number) ?? (raw.timestamp as number) ?? undefined,
    _raw: raw,
  };
}

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

export function useMyAquaPositions() {
  const { address } = useConnection();

  const query = useQuery({
    queryKey: ["aqua", "my-positions", address] as const,
    queryFn: () => fetchAquaPositionsForMaker(address as string),
    staleTime: 0,
    retry: 1,
    enabled: !!address,
  });

  return {
    positions: (query.data ?? []) as EnrichedAquaPosition[],
    isLoading: query.isLoading,
    error: (query.error as Error | null)?.message ?? null,
    effectiveMaker: (address ?? null) as string | null,
    refresh: async () => {
      await query.refetch();
    },
  };
}
