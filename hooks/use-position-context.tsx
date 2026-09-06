"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { EnrichedPosition, PoolKey } from "@/lib/positions/types";
import {
  POSITION_MANAGER,
  POSITION_MANAGER_ABI,
  STATE_VIEW,
  STATE_VIEW_ABI,
} from "@/lib/positions/constants";
import {
  calculateRangeStatus,
  computePoolId,
  decodePositionInfo,
  getTokenSymbol,
} from "@/lib/positions/utils";
import { enrichPosition } from "@/lib/positions/enrich";
import { discoverPositions, clearDiscoveryCache } from "@/lib/positions/discover";

type PositionContextValue = {
  positions: EnrichedPosition[];
  selectedPosition: EnrichedPosition | null;
  selectPosition: (tokenId: string) => void;
  clearSelection: () => void;
  loadPosition: (tokenId: string, autoSelect?: boolean) => Promise<void>;
  refresh: () => void;
  isLoading: boolean;
  error: string | null;
};

const PositionContext = createContext<PositionContextValue | null>(null);

export function PositionProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [positions, setPositions] = useState<EnrichedPosition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPosition = useMemo(
    () => positions.find((p) => p.tokenId === selectedId) ?? null,
    [positions, selectedId]
  );

  const loadPosition = useCallback(
    async (tokenId: string, autoSelect = true) => {
      if (!publicClient) {
        setError("No RPC client available");
        return;
      }

      if (positions.find((p) => p.tokenId === tokenId)) {
        if (autoSelect) setSelectedId(tokenId);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const tokenIdBigInt = BigInt(tokenId);

        const [infoResult, liquidityResult] = await publicClient.multicall({
          contracts: [
            {
              address: POSITION_MANAGER,
              abi: POSITION_MANAGER_ABI,
              functionName: "getPoolAndPositionInfo",
              args: [tokenIdBigInt],
            },
            {
              address: POSITION_MANAGER,
              abi: POSITION_MANAGER_ABI,
              functionName: "getPositionLiquidity",
              args: [tokenIdBigInt],
            },
          ],
          allowFailure: false,
        });

        const [poolKey, packedInfo] = infoResult as [PoolKey, bigint];
        const liquidity = liquidityResult as bigint;
        const { tickLower, tickUpper } = decodePositionInfo(packedInfo);

        const poolId = computePoolId(poolKey);

        const [slot0Result, poolLiqResult] = await publicClient.multicall({
          contracts: [
            {
              address: STATE_VIEW,
              abi: STATE_VIEW_ABI,
              functionName: "getSlot0",
              args: [poolId],
            },
            {
              address: STATE_VIEW,
              abi: STATE_VIEW_ABI,
              functionName: "getLiquidity",
              args: [poolId],
            },
          ],
          allowFailure: false,
        });

        const [sqrtPriceX96, currentTick] = slot0Result as [bigint, number, number, number];
        const totalLiquidity = poolLiqResult as bigint;

        const { isInRange, percentOutOfRange } = calculateRangeStatus(
          tickLower,
          tickUpper,
          currentTick
        );

        // Skip positions with zero liquidity (fully withdrawn)
        if (liquidity === 0n) {
          console.log(`[positions] Skipping #${tokenId} — zero liquidity`);
          return;
        }

        const enriched: EnrichedPosition = {
          tokenId,
          poolKey,
          tickLower,
          tickUpper,
          liquidity,
          pool: { poolId, sqrtPriceX96, currentTick, totalLiquidity },
          isInRange,
          percentOutOfRange,
          token0Symbol: getTokenSymbol(poolKey.currency0),
          token1Symbol: getTokenSymbol(poolKey.currency1),
        };

        setPositions((prev) => {
          const existing = prev.findIndex((p) => p.tokenId === tokenId);
          if (existing >= 0) {
            const next = [...prev];
            next[existing] = enriched;
            return next;
          }
          return [...prev, enriched];
        });
        if (autoSelect) setSelectedId(tokenId);

        // Enrich with metrics in background
        enrichPosition(enriched, publicClient)
          .then((metrics) => {
            setPositions((prev) =>
              prev.map((p) =>
                p.tokenId === tokenId
                  ? { ...p, metrics }
                  : p
              )
            );
          })
          .catch((err) => console.warn("Metrics enrichment failed:", err));
      } catch (err) {
        console.error("Failed to load position:", err);
        setError("Failed to load position.");
      } finally {
        setIsLoading(false);
      }
    },
    [publicClient, positions]
  );

  // Auto-discover positions via subgraph (instant)
  const hasDiscovered = useRef(false);
  useEffect(() => {
    if (!address || !publicClient || hasDiscovered.current) return;
    hasDiscovered.current = true;

    (async () => {
      setIsLoading(true);
      try {
        const discovered = await discoverPositions(address);

        if (discovered.length === 0) {
          setIsLoading(false);
          return;
        }

        // Load each position on-chain (don't auto-select)
        for (const pos of discovered) {
          try {
            await loadPosition(pos.tokenId, false);
          } catch {
            // Skip positions that fail
          }
        }
      } catch (err) {
        console.error("Failed to discover positions:", err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [address, publicClient, loadPosition]);

  // Reset on disconnect
  useEffect(() => {
    if (!address) {
      hasDiscovered.current = false;
      setPositions([]);
      setSelectedId(null);
    }
  }, [address]);

  const selectPosition = useCallback((tokenId: string) => {
    setSelectedId(tokenId);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);

  const refresh = useCallback(() => {
    clearDiscoveryCache();
    hasDiscovered.current = false;
    setPositions([]);
    setSelectedId(null);
    // Re-trigger discovery
    if (address && publicClient) {
      setIsLoading(true);
      discoverPositions(address, true)
        .then(async (discovered) => {
          for (const pos of discovered) {
            try {
              await loadPosition(pos.tokenId, false);
            } catch {}
          }
        })
        .catch((err) => console.error("Refresh failed:", err))
        .finally(() => setIsLoading(false));
    }
  }, [address, publicClient, loadPosition]);

  const value = useMemo<PositionContextValue>(
    () => ({
      positions,
      selectedPosition,
      selectPosition,
      clearSelection,
      loadPosition,
      refresh,
      isLoading,
      error,
    }),
    [positions, selectedPosition, selectPosition, clearSelection, loadPosition, refresh, isLoading, error]
  );

  return (
    <PositionContext.Provider value={value}>
      {children}
    </PositionContext.Provider>
  );
}

export function usePositionContext() {
  const context = useContext(PositionContext);
  if (!context) {
    throw new Error("usePositionContext must be used within PositionProvider");
  }
  return context;
}
