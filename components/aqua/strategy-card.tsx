"use client";

import { TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatUSD, formatAPY } from "@/lib/format";
import { TokenIcon } from "./top-positions/token-icon";

export interface StrategyTokenVM {
  symbol?: string;
  logoURI?: string;
  address: string;
  usd: number;
}

interface StrategyCardProps {
  pair: string;
  tokens: StrategyTokenVM[];
  fee: string | null;
  apy: number | null;
  volume: number | null;
  sizeUsd: number | null;
  showBreakdown?: boolean;
  badge?: ReactNode;
  rank?: number | null;
  headerRight?: ReactNode;
  corner?: ReactNode;
  extra?: ReactNode;
  footer?: ReactNode;
}

export const TOKEN_COLORS: Record<string, string> = {
  ETH: "#627EEA",
  WETH: "#627EEA",
  USDC: "#2775CA",
  USDT: "#26A17B",
  wstETH: "#00A3FF",
  cbBTC: "#F7931A",
  WBTC: "#F7931A",
  "1INCH": "#072341",
};

export function getTokenColor(symbol?: string): string {
  if (!symbol) return "#6B7280";
  return TOKEN_COLORS[symbol] ?? "#6B7280";
}

export function TokenBalanceBar({
  token0Symbol,
  token1Symbol,
  percent0,
}: {
  token0Symbol?: string;
  token1Symbol?: string;
  percent0: number;
}) {
  if (percent0 >= 99.5)
    return (
      <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-muted">
        <div
          className="h-full w-full rounded-full"
          style={{ backgroundColor: getTokenColor(token0Symbol) }}
        />
      </div>
    );
  if (percent0 <= 0.5)
    return (
      <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-muted">
        <div
          className="h-full w-full rounded-full"
          style={{ backgroundColor: getTokenColor(token1Symbol) }}
        />
      </div>
    );
  return (
    <div
      className="flex h-1.5 w-full gap-0.5 rounded-full overflow-hidden"
      role="progressbar"
      aria-valuenow={Math.round(percent0)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${percent0}%`, backgroundColor: getTokenColor(token0Symbol) }}
      />
      <div
        className="h-full rounded-full"
        style={{ width: `${100 - percent0}%`, backgroundColor: getTokenColor(token1Symbol) }}
      />
    </div>
  );
}

export function percentSplit(aUsd: number, bUsd: number): number {
  const total = aUsd + bUsd;
  if (total <= 0) return 50;
  return (aUsd / total) * 100;
}

export function StrategyCard({
  pair,
  tokens,
  fee,
  apy,
  volume,
  sizeUsd,
  showBreakdown = true,
  badge,
  rank,
  headerRight,
  corner,
  extra,
  footer,
}: StrategyCardProps) {
  const [t0, t1] = tokens;
  const percent0 = percentSplit(t0?.usd ?? 0, t1?.usd ?? 0);

  return (
    <Card
      className={cn(
        "group relative flex flex-col gap-0 px-4 pt-3 pb-3 rounded-xl border border-border/50 bg-card",
        "transition-all duration-200",
        "hover:border-border hover:bg-card/80 hover:-translate-y-0.5 hover:shadow-(--shadow-card)",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
      tabIndex={0}
      role="article"
      aria-label={`${pair} strategy`}
    >
      {badge && (
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">{badge}</div>
      )}

      <div className={cn("flex items-center gap-2 mb-2", badge && "pr-20")}>
        {rank != null && (
          <Badge
            variant="default"
            className="flex size-6 shrink-0 items-center justify-center rounded-full p-0 text-xs font-semibold bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            {rank}
          </Badge>
        )}
        <div className="flex -space-x-1">
          <TokenIcon token={t0 as never} size={20} />
          <TokenIcon token={t1 as never} size={20} />
        </div>
        <span className="text-sm font-medium tracking-tight truncate">{pair}</span>
        {fee && (
          <Badge
            variant="muted"
            className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground border-transparent"
          >
            {fee}
          </Badge>
        )}
        {headerRight && <span className="ml-auto shrink-0">{headerRight}</span>}
      </div>

      <div className="grid grid-cols-3 gap-2 mb-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            APY (24h)
          </div>
          <div className="text-sm font-semibold tracking-tight mt-0.5 flex items-center gap-1">
            <TrendingUp className="size-3.5 text-primary" aria-hidden="true" />
            {formatAPY(apy)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            Volume (24h)
          </div>
          <div className="text-sm font-semibold tracking-tight mt-0.5">
            {volume != null ? formatUSD(volume) : "—"}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            Size
          </div>
          <div className="text-sm font-semibold tracking-tight mt-0.5">
            {sizeUsd != null ? formatUSD(sizeUsd) : "—"}
          </div>
        </div>
      </div>

      {extra}

      {showBreakdown && (
        <div className="mt-auto space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: getTokenColor(t0?.symbol) }}
              />
              {t0?.symbol ?? "TOKEN0"} · {formatUSD(t0?.usd ?? 0)}
            </span>
            <span className="flex items-center gap-1">
              {formatUSD(t1?.usd ?? 0)} · {t1?.symbol ?? "TOKEN1"}
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: getTokenColor(t1?.symbol) }}
              />
            </span>
          </div>
          <TokenBalanceBar
            token0Symbol={t0?.symbol}
            token1Symbol={t1?.symbol}
            percent0={percent0}
          />
        </div>
      )}

      {footer && <div className={showBreakdown ? "mt-2" : "mt-auto pt-2"}>{footer}</div>}
    </Card>
  );
}
