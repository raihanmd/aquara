"use client";

import {
  Trophy,
  TrendingUp,
  Sparkles,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  useTopPositions,
  type TopPosition,
  type TopPositionToken,
} from "@/hooks/use-top-positions";

function formatUSD(value: number | null | undefined): string {
  if (value == null || value === 0) return "$0.00";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatAPY(apy: number | null | undefined): string {
  if (apy == null) return "0.0%";
  return `${apy.toFixed(1)}%`;
}

function getPairLabel(pos: TopPosition): string {
  const t0 =
    pos.tokens?.[0]?.symbol ??
    pos.tokens?.[0]?.address?.slice(0, 6) ??
    "TOKEN0";
  const t1 =
    pos.tokens?.[1]?.symbol ??
    pos.tokens?.[1]?.address?.slice(0, 6) ??
    "TOKEN1";
  return `${t0} / ${t1}`;
}

function TokenIcon({
  token,
  size = 20,
}: {
  token?: TopPositionToken;
  size?: number;
}) {
  if (token?.logoURI) {
    return (
      <img
        src={token.logoURI}
        alt={token.symbol ?? token.address}
        width={size}
        height={size}
        className="rounded-full object-cover bg-muted"
      />
    );
  }
  const label = token?.symbol?.slice(0, 1) ?? "?";
  return (
    <span
      className="flex items-center justify-center rounded-full bg-muted text-muted-foreground text-xs font-medium"
      style={{ width: size, height: size }}
    >
      {label}
    </span>
  );
}

function getFeeLabel(pos: TopPosition): string {
  const c = pos.classification;
  if (typeof c === "string" && c.includes("%")) return c;
  if (c && typeof c === "object" && "fee" in c) {
    const fee = (c as Record<string, unknown>).fee;
    if (typeof fee === "string") return fee;
    if (typeof fee === "number") return `${(fee / 10000).toFixed(2)}%`;
  }
  return "0.05%";
}

const CHAIN_OPTIONS = [
  { label: "All Chains", value: "all", chainIds: [1, 4663] },
  { label: "Robinhood", value: "Robinhood", chainIds: [4663] },
  { label: "Ethereum", value: "Ethereum", chainIds: [1] },
] as const;

type ChainFilter = (typeof CHAIN_OPTIONS)[number]["value"];
type SortBy = "volume" | "apy";

function TopPositionCard({
  position,
  rank,
  onDeploy,
}: {
  position: TopPosition;
  rank: number;
  onDeploy?: (pos: TopPosition) => void;
}) {
  console.log("🚀 ~ TopPositionCard ~ position:", position);
  const pair = getPairLabel(position);
  const fee = getFeeLabel(position);
  const apy = position.performance?.fees?.last7d?.apy ?? position.performance?.fees?.last30d?.apy ?? null;
  const volume = position.performance?.volume?.last7d?.usd ?? position.performance?.volume?.last30d?.usd ?? null;
  const isTop = rank === 1;

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border border-border/50 bg-card p-4",
        "transition-all duration-200",
        "hover:border-border hover:bg-card/80 hover:-translate-y-0.5 hover:shadow-(--shadow-card)",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      tabIndex={0}
      role="article"
      aria-label={`${pair} strategy rank ${rank}`}
    >
      <div className="flex items-center gap-3 mb-3">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            "bg-primary text-primary-foreground",
            "transition-colors duration-200",
          )}
          aria-hidden="true"
        >
          {rank}
        </span>
        <div className="flex -space-x-1">
          <TokenIcon token={position.tokens?.[0]} size={20} />
          <TokenIcon token={position.tokens?.[1]} size={20} />
        </div>
        <span className="text-sm font-medium tracking-tight truncate">
          {pair}
        </span>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {fee}
        </span>
      </div>

      <div className="flex items-baseline justify-between mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            APY (7d)
          </div>
          <div className="text-lg font-semibold tracking-tight mt-0.5 flex items-center gap-1">
            <TrendingUp className="size-3.5 text-primary" aria-hidden="true" />
            {formatAPY(apy)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            Volume (7d)
          </div>
          <div className="text-xs text-muted-foreground mt-1 font-medium">
            {formatUSD(volume)}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mb-3">
        <span className="text-xs text-muted-foreground/60">
          {position.chainId === 4663
            ? "Robinhood"
            : position.chainId === 1
              ? "Ethereum"
              : `Chain ${position.chainId}`}
        </span>
        <span className="text-muted-foreground/20">·</span>
        <span className="text-xs text-muted-foreground/60 truncate">
          {position.app.slice(0, 6)}…
        </span>
      </div>

      <div className="mt-auto flex items-center gap-2">
        <button
          onClick={() => onDeploy?.(position)}
          className={cn(
            "flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground",
            "transition-all duration-200",
            "hover:bg-primary/90",
            "active:scale-[0.98]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:opacity-50 disabled:pointer-events-none",
            "cursor-pointer",
          )}
        >
          Deploy
        </button>
        <button
          onClick={() => onDeploy?.(position)}
          className={cn(
            "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground",
            "transition-colors duration-200",
            "hover:bg-muted hover:text-foreground",
            "active:scale-[0.98]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "cursor-pointer",
          )}
          aria-label={`View details for ${pair}`}
        >
          Details
        </button>
      </div>

      {isTop && (
        <div className="absolute -top-px -right-px">
          <span className="flex items-center gap-1 rounded-bl-xl rounded-tr-xl bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground">
            <Trophy className="size-3" aria-hidden="true" />
            Top
          </span>
        </div>
      )}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 h-35 animate-pulse">
      <div className="flex items-center gap-3 mb-3">
        <div className="size-6 rounded-full bg-muted" />
        <div className="h-4 w-24 rounded-md bg-muted" />
        <div className="ml-auto h-5 w-12 rounded-md bg-muted" />
      </div>
      <div className="flex justify-between mb-4">
        <div className="space-y-2">
          <div className="h-3 w-12 rounded bg-muted" />
          <div className="h-5 w-16 rounded bg-muted" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-16 rounded bg-muted" />
          <div className="h-3 w-12 rounded bg-muted ml-auto" />
        </div>
      </div>
      <div className="h-8 rounded-md bg-muted" />
    </div>
  );
}

function EmptyState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-card/40 px-6 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted mb-3">
        <Sparkles
          className="size-5 text-muted-foreground/50"
          aria-hidden="true"
        />
      </div>
      <h3 className="text-sm font-medium">No strategies found</h3>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        No top strategies match your current filters. Try adjusting the chain or
        sort option.
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer"
        >
          Reset filters
        </button>
      )}
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="col-span-full flex flex-col items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 px-6 py-8 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 mb-3">
        <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-medium text-destructive">
        Failed to load strategies
      </h3>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-4 py-2 text-sm font-medium transition-colors duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 cursor-pointer"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}

export function TopPositions({ limit = 3 }: { limit?: number }) {
  const [sortBy, setSortBy] = useState<SortBy>("apy");
  const [chainFilter, setChainFilter] = useState<ChainFilter>("Robinhood");
  const selectedChain =
    CHAIN_OPTIONS.find((c) => c.value === chainFilter) ?? CHAIN_OPTIONS[0];
  const { data, isLoading, error, refetch } = useTopPositions({
    chainIds: [...selectedChain.chainIds],
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Trophy className="size-3.5" aria-hidden="true" />
          </div>
          <h2
            id="top-strategies-heading"
            className="text-sm font-semibold tracking-tight"
          >
            Top Strategies
          </h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {isLoading ? "…" : data.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Sort strategies"
            className="inline-flex items-center rounded-lg border border-border/50 bg-muted/30 p-1 gap-1"
          >
            <button
              role="tab"
              aria-selected={sortBy === "volume"}
              onClick={() => setSortBy("volume")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                sortBy === "volume"
                  ? "bg-card text-foreground shadow-sm border border-border/50"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Volume
            </button>
            <button
              role="tab"
              aria-selected={sortBy === "apy"}
              onClick={() => setSortBy("apy")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                sortBy === "apy"
                  ? "bg-card text-foreground shadow-sm border border-border/50"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              APY
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <label
              htmlFor="chain-filter"
              className="text-xs text-muted-foreground sr-only"
            >
              Filter by chain
            </label>
            <select
              id="chain-filter"
              value={chainFilter}
              onChange={(e) => setChainFilter(e.target.value as ChainFilter)}
              className={cn(
                "rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-xs font-medium",
                "text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "cursor-pointer transition-colors duration-200 hover:border-border",
              )}
            >
              {CHAIN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
      >
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
              setChainFilter("all");
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
