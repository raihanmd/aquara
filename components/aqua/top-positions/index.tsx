"use client";

import { useState } from "react";
import { useTopPositions, type TopPosition } from "@/hooks/use-top-positions";
import { TopPositionsHeader } from "./top-positions-header";
import { TopPositionCard } from "./top-position-card";
import { CardSkeleton } from "./top-positions-skeleton";
import { EmptyState } from "./top-positions-empty";
import { ErrorState } from "./top-positions-error";
import { CHAIN_OPTIONS, type ChainFilter, type SortBy } from "./types";

export function TopPositions({ limit = 3 }: { limit?: number }) {
  const [sortBy, setSortBy] = useState<SortBy>("volume");
  const [chainFilter, setChainFilter] = useState<ChainFilter>("Base");
  const selectedChain =
    CHAIN_OPTIONS.find((c) => c.value === chainFilter) ?? CHAIN_OPTIONS[0];
  const isUnsupportedChain = chainFilter !== "Base";
  const effectiveChainIds = isUnsupportedChain
    ? [8453]
    : [...selectedChain.chainIds];
  const { data, isLoading, error, refetch } = useTopPositions({
    chainIds: effectiveChainIds,
    limit,
    sortBy,
  });

  const handleDeploy = (pos: TopPosition) => {
    console.log("[TopPositions] Deploy", pos.strategyHash);
  };

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="top-strategies-heading"
    >
      <TopPositionsHeader
        count={data.length}
        isLoading={isLoading}
        sortBy={sortBy}
        onSortChange={setSortBy}
        chainFilter={chainFilter}
        onChainFilterChange={setChainFilter}
      />

      {isUnsupportedChain && (
        <div className="rounded-lg border border-warning/30 bg-warning px-3 py-2 text-xs text-warning-foreground">
          {chainFilter} not supported for MVP — showing Base only. Switch to Base to deploy.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          <>
            {Array.from({ length: limit }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </>
        ) : error ? (
          <ErrorState message={error.message} onRetry={() => refetch()} />
        ) : data.length === 0 ? (
          <EmptyState
            onRetry={() => {
              setChainFilter("Base");
              setSortBy("volume");
            }}
          />
        ) : (
          data.map((pos, idx) => (
            <TopPositionCard
              key={`${pos.chainId}-${pos.strategyHash}-${idx}`}
              position={pos}
              rank={idx + 1}
              onDeploy={handleDeploy}
            />
          ))
        )}
      </div>
    </section>
  );
}

export default TopPositions;
