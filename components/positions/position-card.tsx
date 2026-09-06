"use client";

import type { EnrichedPosition } from "@/lib/positions/types";
import { usePoolPrices, type PricePoint } from "@/hooks/use-pool-prices";
import { useDelegation } from "@/hooks/use-delegation";

const TOKEN_COLORS: Record<string, string> = {
  ETH: "#627EEA",
  WETH: "#627EEA",
  USDC: "#2775CA",
  USDS: "#F5AC37",
  cbBTC: "#0052FF",
  USDT: "#26A17B",
  VIRTUAL: "#7BEA62",
  wstETH: "#00A3FF",
};

const DEFAULT_TOKEN_COLOR = "#6B7280";

function getTokenColor(symbol: string): string {
  return TOKEN_COLORS[symbol] ?? DEFAULT_TOKEN_COLOR;
}

function StatusDot() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0">
      <circle cx="4" cy="4" r="4" fill="currentColor" fillOpacity="0.4" className="text-red-500" />
      <circle cx="4" cy="4" r="2" fill="currentColor" className="text-red-500" />
    </svg>
  );
}

function TokenRatioBar({
  token0Symbol, token1Symbol, percent0,
}: {
  token0Symbol: string; token1Symbol: string; percent0: number;
}) {
  if (percent0 >= 99.5) {
    return (
      <div className="flex h-1 w-full rounded-full overflow-hidden">
        <div className="h-full w-full rounded-full" style={{ backgroundColor: getTokenColor(token0Symbol) }} />
      </div>
    );
  }
  if (percent0 <= 0.5) {
    return (
      <div className="flex h-1 w-full rounded-full overflow-hidden">
        <div className="h-full w-full rounded-full" style={{ backgroundColor: getTokenColor(token1Symbol) }} />
      </div>
    );
  }
  return (
    <div className="flex h-1 w-full gap-0.5 rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${percent0}%`, backgroundColor: getTokenColor(token0Symbol) }} />
      <div className="h-full rounded-full" style={{ width: `${100 - percent0}%`, backgroundColor: getTokenColor(token1Symbol) }} />
    </div>
  );
}

function MiniPriceChart({
  prices, tickLower, tickUpper, currentTick, isInRange,
}: {
  prices: PricePoint[]; tickLower: number; tickUpper: number; currentTick: number; isInRange: boolean;
}) {
  const priceValues = prices.map((p) => p.token0Price);

  if (priceValues.length < 2) {
    return <ChartSkeleton />;
  }

  const tickToPrice = (tick: number) => Math.pow(1.0001, tick);
  const lowerPrice = tickToPrice(tickLower);
  const upperPrice = tickToPrice(tickUpper);

  const minP = Math.min(...priceValues);
  const maxP = Math.max(...priceValues);
  const pricePad = (maxP - minP) * 0.15 || maxP * 0.02;

  let yMin = minP - pricePad;
  let yMax = maxP + pricePad;

  const rangeThresholdLow = minP - pricePad;
  const rangeThresholdHigh = maxP + pricePad;
  const showLowerRange = lowerPrice >= rangeThresholdLow;
  const showUpperRange = upperPrice <= rangeThresholdHigh;

  if (showLowerRange) yMin = Math.min(yMin, lowerPrice - pricePad * 0.5);
  if (showUpperRange) yMax = Math.max(yMax, upperPrice + pricePad * 0.5);

  const yRange = yMax - yMin || 1;
  const priceToY = (p: number) => 100 - ((p - yMin) / yRange) * 100;

  // Build segments: white in-range, muted out-of-range
  const segments: { d: string; inRange: boolean }[] = [];
  let currentSegment: { points: string[]; inRange: boolean } | null = null;

  for (let i = 0; i < priceValues.length; i++) {
    const p = priceValues[i];
    const x = (i / (priceValues.length - 1)) * 100;
    const y = priceToY(p);
    const pointInRange = p >= lowerPrice && p <= upperPrice;
    const coord = `${x.toFixed(1)} ${y.toFixed(1)}`;

    if (!currentSegment || currentSegment.inRange !== pointInRange) {
      if (currentSegment) {
        segments.push({ d: "M " + currentSegment.points.join(" L "), inRange: currentSegment.inRange });
      }
      currentSegment = {
        points: currentSegment ? [currentSegment.points[currentSegment.points.length - 1], coord] : [coord],
        inRange: pointInRange,
      };
    } else {
      currentSegment.points.push(coord);
    }
  }
  if (currentSegment) {
    segments.push({ d: "M " + currentSegment.points.join(" L "), inRange: currentSegment.inRange });
  }

  const rangeTopY = priceToY(upperPrice);
  const rangeBotY = priceToY(lowerPrice);

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="none">
      {(showLowerRange || showUpperRange) && (
        <rect x="0" y={showUpperRange ? rangeTopY : 0}
          width="100" height={Math.max(0.5, (showLowerRange ? rangeBotY : 100) - (showUpperRange ? rangeTopY : 0))}
          fill="white" fillOpacity="0.04" />
      )}
      {showUpperRange && (
        <line x1="0" y1={rangeTopY} x2="100" y2={rangeTopY}
          stroke="white" strokeWidth="0.5" strokeOpacity="0.12" vectorEffect="non-scaling-stroke" />
      )}
      {showLowerRange && (
        <line x1="0" y1={rangeBotY} x2="100" y2={rangeBotY}
          stroke="white" strokeWidth="0.5" strokeOpacity="0.12" vectorEffect="non-scaling-stroke" />
      )}
      {segments.map((seg, i) => (
        <path key={i} d={seg.d} fill="none"
          stroke={seg.inRange ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.5)"}
          strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

function ChartSkeleton() {
  return (
    <div className="w-full h-full rounded bg-muted/20" />
  );
}

function formatUSD(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return "$0.00";
}

export function PositionCard({
  position,
  onClick,
}: {
  position: EnrichedPosition;
  onClick?: () => void;
}) {
  const m = position.metrics;
  const { prices } = usePoolPrices(position.pool.poolId);
  const { status: delegationStatus } = useDelegation();
  const isDelegated = delegationStatus === "delegated";

  // Compute token ratio from amounts — use 100/0 for OOR positions
  let percent0 = 50;
  if (m) {
    if (m.positionSizeUSD > 0) {
      const val0 = parseFloat(m.amount0) * m.token0PriceUSD;
      percent0 = (val0 / m.positionSizeUSD) * 100;
    } else if (parseFloat(m.amount0) > 0 && parseFloat(m.amount1) === 0) {
      percent0 = 100;
    } else if (parseFloat(m.amount0) === 0 && parseFloat(m.amount1) > 0) {
      percent0 = 0;
    }
  }

  return (
    <div
      onClick={onClick}
      className="relative flex flex-col h-[170px] rounded-xl border border-border/50 bg-card overflow-hidden transition-all duration-200 hover:border-border hover:bg-card/80 hover:-translate-y-0.5 hover:shadow-[var(--shadow-card)] cursor-pointer"
    >
      {/* Delegation badge — top right */}
      <div className="absolute top-2.5 right-2.5">
        {delegationStatus === "unknown" || delegationStatus === "checking" ? (
          <span className="rounded-md px-2.5 py-1 text-[10px] font-medium bg-muted/30 text-transparent animate-pulse">
            Checking...
          </span>
        ) : (
          <span
            className={`rounded-md px-2.5 py-1 text-[10px] font-medium ${
              isDelegated
                ? "bg-green-500/15 text-green-500"
                : "bg-red-500/15 text-red-500"
            }`}
          >
            {isDelegated ? "Delegated" : "Not Delegated"}
          </span>
        )}
      </div>

      {/* Top row: info + chart side by side */}
      <div className="flex flex-1 min-w-0 min-h-0">
        {/* Info */}
        <div className="flex flex-col justify-between p-3.5 min-w-[120px] shrink-0">
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              {!position.isInRange && <StatusDot />}
              <span className="text-[15px] font-medium">
                {position.token0Symbol} / {position.token1Symbol}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground/50">
              {position.isInRange ? "In Range" : "Out of Range"}
              {m?.feePercent ? ` · ${m.feePercent}` : ""}
            </div>
          </div>

          <div>
            <div className="text-lg font-semibold tracking-tight">
              {m ? formatUSD(m.positionSizeUSD) : "—"}
            </div>
            {m && m.feesEarnedUSD > 0 && (
              <div className="text-[11px] text-muted-foreground/50">
                +{formatUSD(m.feesEarnedUSD)} fees
              </div>
            )}
          </div>
        </div>

        {/* Chart — takes remaining space */}
        <div className="flex-1 min-w-0 py-4 pr-3">
          <MiniPriceChart
            prices={prices}
            tickLower={position.tickLower}
            tickUpper={position.tickUpper}
            currentTick={position.pool.currentTick}
            isInRange={position.isInRange}
          />
        </div>
      </div>

      {/* Bottom: full-width token ratio bar */}
      {m && (
        <div className="px-3.5 pb-2">
          <TokenRatioBar
            token0Symbol={position.token0Symbol}
            token1Symbol={position.token1Symbol}
            percent0={percent0}
          />
        </div>
      )}
    </div>
  );
}
