"use client";

import { motion } from "framer-motion";
import {
  ArrowLeftIcon,
  ActivityIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EnrichedPosition } from "@/lib/positions/types";
import { usePoolPrices, type PricePoint, type Duration } from "@/hooks/use-pool-prices";
import { usePositionContext } from "@/hooks/use-position-context";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/delegation/constants";
import { useAccount } from "wagmi";

// ── Helpers ──────────────────────────────────────────────────────────────

function formatUSD(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return "$0.00";
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function tickToPrice(tick: number): string {
  const price = Math.pow(1.0001, tick);
  if (price >= 0.01 && price <= 100_000) return `$${price.toFixed(2)}`;
  return price.toPrecision(4);
}

// ── Rebalance record type (shared by chart + table) ─────────────────────

interface RebalanceRecord {
  id: string;
  tokenId: string;
  owner: string;
  timestamp: number;
  success: boolean;
  txHash?: string;
  newRange?: { tickLower: number; tickUpper: number };
  error?: string;
}

// ── Price Chart ─────────────────────────────────────────────────────────

function PriceChart({
  prices,
  tickLower,
  tickUpper,
  currentTick,
  token0Symbol,
  token1Symbol,
}: {
  prices: PricePoint[];
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  token0Symbol: string;
  token1Symbol: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; price: number; time: number } | null>(null);

  const priceValues = prices.map((p) => p.token0Price);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || priceValues.length < 2) return;
    const rect = containerRef.current.getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(xRatio * (prices.length - 1));
    const pt = prices[idx];
    if (pt) setHover({ x: xRatio * 100, price: pt.token0Price, time: pt.timestamp });
  }, [prices, priceValues.length]);

  if (priceValues.length < 2) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <span className="text-xs text-muted-foreground/40">Loading chart...</span>
      </div>
    );
  }

  const refPrice = priceValues[priceValues.length - 1];
  const tickToPriceNum = (tick: number) => refPrice * Math.pow(1.0001, tick - currentTick);
  const pA = tickToPriceNum(tickLower);
  const pB = tickToPriceNum(tickUpper);
  const lowerPrice = Math.min(pA, pB);
  const upperPrice = Math.max(pA, pB);

  const minP = Math.min(...priceValues);
  const maxP = Math.max(...priceValues);
  const pricePad = (maxP - minP) * 0.15 || maxP * 0.02;

  // Always include range bounds in the view
  let yMin = Math.min(minP - pricePad, lowerPrice - pricePad * 0.3);
  let yMax = Math.max(maxP + pricePad, upperPrice + pricePad * 0.3);

  const yRange = yMax - yMin || 1;
  const priceToY = (p: number) => 100 - ((p - yMin) / yRange) * 100;

  // Build line segments with precise boundary interpolation
  const segments: { d: string; inRange: boolean }[] = [];
  let currentSegment: { points: string[]; inRange: boolean } | null = null;

  const lerp = (x1: number, y1: number, x2: number, y2: number, targetY: number) => {
    if (y2 === y1) return x1;
    return x1 + ((targetY - y1) / (y2 - y1)) * (x2 - x1);
  };

  for (let i = 0; i < priceValues.length; i++) {
    const p = priceValues[i];
    const x = (i / (priceValues.length - 1)) * 100;
    const y = priceToY(p);
    const pointInRange = p >= lowerPrice && p <= upperPrice;
    const coord = `${x.toFixed(2)} ${y.toFixed(2)}`;

    if (i > 0 && currentSegment && currentSegment.inRange !== pointInRange) {
      const prevP = priceValues[i - 1];
      const prevX = ((i - 1) / (priceValues.length - 1)) * 100;
      const boundary = pointInRange
        ? (prevP < lowerPrice ? lowerPrice : upperPrice)
        : (p < lowerPrice ? lowerPrice : upperPrice);
      const bx = lerp(prevX, prevP, x, p, boundary);
      const by = priceToY(boundary);
      const bCoord = `${bx.toFixed(2)} ${by.toFixed(2)}`;

      currentSegment.points.push(bCoord);
      segments.push({ d: "M " + currentSegment.points.join(" L "), inRange: currentSegment.inRange });
      currentSegment = { points: [bCoord, coord], inRange: pointInRange };
    } else if (!currentSegment) {
      currentSegment = { points: [coord], inRange: pointInRange };
    } else {
      currentSegment.points.push(coord);
    }
  }
  if (currentSegment) {
    segments.push({ d: "M " + currentSegment.points.join(" L "), inRange: currentSegment.inRange });
  }

  const rangeTopY = priceToY(upperPrice);
  const rangeBotY = priceToY(lowerPrice);
  const hoverY = hover ? priceToY(hover.price) : 0;

  const STABLES = ["USDC", "USDS", "USDT", "DAI"];
  const isUSDPair = STABLES.includes(token1Symbol) || STABLES.includes(token0Symbol);
  const formatPrice = (p: number) => p >= 1 ? p.toFixed(2) : p.toFixed(6);
  const formatRangeLabel = (p: number) => isUSDPair ? `$${formatPrice(p)}` : formatPrice(p);
  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="relative w-full h-full" ref={containerRef}
      onMouseMove={handleMouseMove} onMouseLeave={() => setHover(null)}
    >
      {/* Range labels */}
      <div className="absolute right-1 text-[9px] text-green-400/50 pointer-events-none"
        style={{ top: `${rangeTopY}%`, transform: "translateY(-100%)" }}>
        {formatRangeLabel(upperPrice)}
      </div>
      <div className="absolute right-1 text-[9px] text-green-400/50 pointer-events-none"
        style={{ top: `${rangeBotY}%` }}>
        {formatRangeLabel(lowerPrice)}
      </div>

      {hover && (
        <>
          <div className="absolute top-0 pointer-events-none z-10"
            style={{ left: `${hover.x}%`, transform: "translateX(-50%)" }}>
            <div className="bg-card border border-border/60 rounded-lg px-2.5 py-1.5 shadow-lg">
              <div className="text-[11px] font-medium text-foreground">
                {isUSDPair ? "$" : ""}{formatPrice(hover.price)}{!isUSDPair ? ` ${token1Symbol}` : ""}
              </div>
              <div className="text-[9px] text-muted-foreground/50">{formatTime(hover.time)}</div>
            </div>
          </div>
          <div
            className="absolute size-2 rounded-full bg-white pointer-events-none z-10"
            style={{ left: `${hover.x}%`, top: `${hoverY}%`, transform: "translate(-50%, -50%)" }}
          />
        </>
      )}

      <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="none">
        {/* Range band */}
        <rect
          x="0" y={rangeTopY}
          width="100"
          height={Math.max(0.5, rangeBotY - rangeTopY)}
          fill="#22c55e" fillOpacity="0.06"
        />
        {/* Upper range line */}
        <line x1="0" y1={rangeTopY} x2="100" y2={rangeTopY}
          stroke="#22c55e" strokeWidth="0.5" strokeOpacity="0.3" strokeDasharray="2,2"
          vectorEffect="non-scaling-stroke" />
        {/* Lower range line */}
        <line x1="0" y1={rangeBotY} x2="100" y2={rangeBotY}
          stroke="#22c55e" strokeWidth="0.5" strokeOpacity="0.3" strokeDasharray="2,2"
          vectorEffect="non-scaling-stroke" />
        {/* Price line segments */}
        {segments.map((seg, i) => (
          <path key={i} d={seg.d} fill="none"
            stroke={seg.inRange ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)"}
            strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}
        {/* Rebalance dots */}
        {/* Hover crosshair */}
        {hover && (
          <line x1={hover.x} y1="0" x2={hover.x} y2="100"
            stroke="white" strokeWidth="0.5" strokeOpacity="0.15"
            vectorEffect="non-scaling-stroke" />
        )}
      </svg>

    </div>
  );
}

const DURATIONS: { label: string; value: Duration }[] = [
  { label: "1H", value: "HOUR" },
  { label: "1D", value: "DAY" },
  { label: "1W", value: "WEEK" },
  { label: "1M", value: "MONTH" },
  { label: "1Y", value: "YEAR" },
];

// ── Actions List ─────────────────────────────────────────────────────────

interface Activity {
  id: string;
  type: string;
  status: string;
  summary: string;
  timestamp: number;
  tokenId?: string;
  owner?: string;
  txHashes?: string[];
}

function ActionsList({ ownerAddress }: { ownerAddress?: string }) {
  const [actions, setActions] = useState<Activity[]>([]);

  useEffect(() => {
    const fetchActions = () => {
      const params = new URLSearchParams({ limit: "20" });
      if (ownerAddress) params.set("address", ownerAddress);
      fetch(`${API_URL}/api/actions?${params}`)
        .then((r) => r.json())
        .then((data: Activity[]) => {
          if (!Array.isArray(data)) return;
          const filtered = data.filter((a) => a.type !== "monitor");
          setActions(filtered.slice(0, 10));
        })
        .catch(() => {});
    };
    fetchActions();
    const interval = setInterval(fetchActions, 15_000);
    return () => clearInterval(interval);
  }, [ownerAddress]);

  if (actions.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-muted-foreground/40">
        No activity yet
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {actions.map((action) => (
        <div
          key={action.id}
          className="flex items-start gap-2.5 px-2 py-2"
        >
          <div className="mt-0.5">
            {action.status === "completed" ? (
              <CheckCircleIcon className="size-3 text-muted-foreground/40" />
            ) : action.status === "failed" ? (
              <AlertCircleIcon className="size-3 text-red-400/60" />
            ) : (
              <ActivityIcon className="size-3 text-muted-foreground/40" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-foreground/70 leading-relaxed">{action.summary}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground/30">{timeAgo(action.timestamp)}</span>
              {action.txHashes?.[0] && (
                <a
                  href={`https://basescan.org/tx/${action.txHashes[0]}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-blue-400/50 hover:text-blue-400 transition-colors"
                >
                  tx
                </a>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Rebalance History ───────────────────────────────────────────────────

function RebalanceHistory({ ownerAddress, records }: { ownerAddress?: string; records: RebalanceRecord[] }) {
  if (records.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-muted-foreground/40">
        No rebalances yet
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {records.map((r) => (
        <div key={r.id} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-card/30 transition-colors">
          <div className="shrink-0">
            {r.success ? (
              <CheckCircleIcon className="size-3 text-green-400/60" />
            ) : (
              <AlertCircleIcon className="size-3 text-red-400/60" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-foreground/70">
                {r.newRange
                  ? `${tickToPrice(r.newRange.tickLower)} – ${tickToPrice(r.newRange.tickUpper)}`
                  : r.success ? "Rebalanced" : "Failed"}
              </span>
              <span className="text-[10px] text-muted-foreground/30">#{r.tokenId}</span>
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground/30 shrink-0">{timeAgo(r.timestamp)}</span>
          {r.txHash && (
            <a
              href={`https://basescan.org/tx/${r.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-blue-400/50 hover:text-blue-400 transition-colors shrink-0"
            >
              tx
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────────────

export function PositionDashboard({
  position,
}: {
  position: EnrichedPosition;
  onSuggestedAction?: (text: string) => void;
}) {
  const m = position.metrics;
  const [duration, setDuration] = useState<Duration>("WEEK");
  const { prices } = usePoolPrices(position.pool.poolId, duration);
  const { clearSelection } = usePositionContext();
  const { address } = useAccount();
  const [activeTab, setActiveTab] = useState<"rebalances" | "activity">("rebalances");
  const [rebalanceRecords, setRebalanceRecords] = useState<RebalanceRecord[]>([]);


  // Fetch rebalance records (shared between chart dots and table)
  useEffect(() => {
    const fetchRebalances = () => {
      const params = new URLSearchParams({ limit: "20" });
      if (address) params.set("address", address);
      fetch(`${API_URL}/api/rebalances?${params}`)
        .then((r) => r.json())
        .then((data: RebalanceRecord[]) => {
          if (Array.isArray(data)) setRebalanceRecords(data);
        })
        .catch(() => {});
    };
    fetchRebalances();
    const interval = setInterval(fetchRebalances, 30_000);
    return () => clearInterval(interval);
  }, [address]);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      {/* Back button + title */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={clearSelection}
          className="rounded-lg p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors cursor-pointer"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <h2 className="text-lg font-semibold tracking-tight">
          {position.token0Symbol} / {position.token1Symbol}
        </h2>
        <div className="flex items-center gap-1.5">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <circle cx="4" cy="4" r="4" fill="currentColor" fillOpacity="0.4"
              className={position.isInRange ? "text-green-500" : "text-red-500"} />
            <circle cx="4" cy="4" r="2" fill="currentColor"
              className={position.isInRange ? "text-green-500" : "text-red-500"} />
          </svg>
          <span className={cn("text-xs font-medium", position.isInRange ? "text-green-500" : "text-red-400")}>
            {position.isInRange ? "In Range" : "Out of Range"}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground/40">#{position.tokenId}</span>
      </div>

      {/* Loading skeleton */}
      {!prices || prices.length === 0 || !m ? (
        <div className="space-y-4">
          <div className="h-[220px] rounded-xl animate-pulse bg-card/50" />
          <div className="grid grid-cols-4 gap-3">
            <div className="h-14 rounded-lg animate-pulse bg-card/50" />
            <div className="h-14 rounded-lg animate-pulse bg-card/50" />
            <div className="h-14 rounded-lg animate-pulse bg-card/50" />
            <div className="h-14 rounded-lg animate-pulse bg-card/50" />
          </div>
          <div className="h-[160px] rounded-xl animate-pulse bg-card/50" />
        </div>
      ) : (
        <>
          {/* Chart — full width */}
          <motion.div
            className="rounded-xl border border-border/50 bg-card p-3 h-[220px] flex flex-col mb-4"
            animate={{ opacity: 1, y: 0 }}
            initial={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-muted-foreground/50">
                {position.token0Symbol} / {position.token1Symbol}
              </span>
              <div className="flex gap-0.5">
                {DURATIONS.map((d) => (
                  <button
                    key={d.value}
                    onClick={() => setDuration(d.value)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer",
                      duration === d.value
                        ? "bg-foreground/10 text-foreground"
                        : "text-muted-foreground/40 hover:text-muted-foreground"
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <PriceChart
                prices={prices}
                tickLower={position.tickLower}
                tickUpper={position.tickUpper}
                currentTick={position.pool.currentTick}
                token0Symbol={position.token0Symbol}
                token1Symbol={position.token1Symbol}
              />
            </div>
          </motion.div>

          {/* Stats — single row of 4 compact cards */}
          <div className="grid grid-cols-4 gap-3 mb-5">
            <motion.div
              animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 4 }}
              transition={{ delay: 0.05, duration: 0.2 }}
              className="rounded-lg border border-border/40 bg-card/60 px-3 py-2"
            >
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground/40 font-medium">Size</div>
              <div className="text-sm font-medium mt-0.5">{formatUSD(m.positionSizeUSD)}</div>
            </motion.div>
            <motion.div
              animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 4 }}
              transition={{ delay: 0.08, duration: 0.2 }}
              className="rounded-lg border border-border/40 bg-card/60 px-3 py-2"
            >
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground/40 font-medium">Fees</div>
              <div className="text-sm font-medium mt-0.5">{formatUSD(m.feesEarnedUSD)}</div>
            </motion.div>
            <motion.div
              animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 4 }}
              transition={{ delay: 0.11, duration: 0.2 }}
              className="rounded-lg border border-border/40 bg-card/60 px-3 py-2"
            >
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground/40 font-medium">Price</div>
              <div className="text-sm font-medium mt-0.5">{parseFloat(m.currentPrice).toFixed(2)}</div>
            </motion.div>
            <motion.div
              animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 4 }}
              transition={{ delay: 0.14, duration: 0.2 }}
              className="rounded-lg border border-border/40 bg-card/60 px-3 py-2"
            >
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground/40 font-medium">APY</div>
              <div className="text-sm font-medium mt-0.5">
                {m.apyEstimate != null ? `${m.apyEstimate.toFixed(1)}%` : "—"}
              </div>
            </motion.div>
          </div>

          {/* Tabs: Rebalances (left, default) | Activity (right) */}
          <motion.div
            animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 6 }}
            transition={{ delay: 0.2, duration: 0.3 }}
          >
            <div className="flex items-center gap-4 mb-3 border-b border-border/30 pb-2">
              <button
                onClick={() => setActiveTab("rebalances")}
                className={cn(
                  "text-xs font-medium transition-colors cursor-pointer pb-1",
                  activeTab === "rebalances"
                    ? "text-foreground/80 border-b border-foreground/30"
                    : "text-muted-foreground/40 hover:text-muted-foreground/60"
                )}
              >
                Rebalances
              </button>
              <button
                onClick={() => setActiveTab("activity")}
                className={cn(
                  "text-xs font-medium transition-colors cursor-pointer pb-1",
                  activeTab === "activity"
                    ? "text-foreground/80 border-b border-foreground/30"
                    : "text-muted-foreground/40 hover:text-muted-foreground/60"
                )}
              >
                Activity
              </button>
            </div>

            {activeTab === "rebalances" ? (
              <RebalanceHistory ownerAddress={address} records={rebalanceRecords} />
            ) : (
              <ActionsList ownerAddress={address} />
            )}
          </motion.div>
        </>
      )}
    </div>
  );
}
