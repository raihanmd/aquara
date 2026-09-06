"use client";

import { TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TokenIcon } from "@/components/aqua/top-positions/token-icon";
import { formatUSD, formatAPY } from "@/lib/format";
import type { EnrichedAquaPosition } from "@/hooks/use-my-aqua-positions";

function getPairLabel(pos: EnrichedAquaPosition): string {
  const t0 = pos.tokens?.[0]?.symbol ?? pos.tokens?.[0]?.address?.slice(0, 6) ?? "TOKEN0";
  const t1 = pos.tokens?.[1]?.symbol ?? pos.tokens?.[1]?.address?.slice(0, 6) ?? "TOKEN1";
  return `${t0} / ${t1}`;
}

function getFeeLabel(pos: EnrichedAquaPosition): string {
  const c = pos.classification;
  if (typeof c === "string" && c.includes("%")) return c;
  if (c && typeof c === "object") {
    const rec = c as Record<string, unknown>;
    if (typeof rec.fee === "string") return rec.fee as string;
    if (typeof rec.fee === "number") return `${((rec.fee as number) / 10000).toFixed(2)}%`;
    if (typeof rec.feePercent === "string") return rec.feePercent as string;
    if (typeof rec.feeTier === "number") return `${((rec.feeTier as number) / 10000).toFixed(2)}%`;
  }
  return "—";
}

function getApy(pos: EnrichedAquaPosition): number | null {
  return (
    pos.performance?.fees?.last7d?.apy ??
    pos.performance?.fees?.last30d?.apy ??
    pos.performance?.fees?.total?.apy ??
    null
  );
}

function getTokenUsd(t: EnrichedAquaPosition["tokens"][number]): number {
  const bal: any = (t as any).currentBalance;
  if (bal && typeof bal === "object" && typeof bal.usd === "number") return bal.usd ?? 0;
  return 0;
}

function getSizeUsd(pos: EnrichedAquaPosition): number | null {
  const fromTokens = pos.tokens.reduce((s, t) => s + getTokenUsd(t), 0);
  if (fromTokens > 0) return fromTokens;
  const v7 = pos.performance?.volume?.last7d?.usd;
  const v30 = pos.performance?.volume?.last30d?.usd;
  if (typeof v7 === "number" && v7 > 0) return v7;
  if (typeof v30 === "number" && v30 > 0) return v30;
  const feesUsd = pos.performance?.fees?.last7d?.usd ?? pos.performance?.fees?.last30d?.usd;
  if (typeof feesUsd === "number" && feesUsd > 0) return feesUsd;
  return null;
}

function getPercent0(pos: EnrichedAquaPosition): number {
  const v0 = getTokenUsd(pos.tokens[0]);
  const v1 = getTokenUsd(pos.tokens[1]);
  const total = v0 + v1;
  if (total <= 0) {
    const raw0: any = (pos.tokens[0] as any)?.currentBalance;
    const raw1: any = (pos.tokens[1] as any)?.currentBalance;
    const r0 = typeof raw0 === "object" ? raw0?.raw : raw0;
    const r1 = typeof raw1 === "object" ? raw1?.raw : raw1;
    if (r0 !== undefined && String(r0) !== "0" && (r1 === undefined || String(r1) === "0")) return 100;
    if (r1 !== undefined && String(r1) !== "0" && (r0 === undefined || String(r0) === "0")) return 0;
    return 50;
  }
  return (v0 / total) * 100;
}

const TOKEN_COLORS: Record<string, string> = {
  ETH: "#627EEA",
  WETH: "#627EEA",
  USDC: "#2775CA",
  USDT: "#26A17B",
  wstETH: "#00A3FF",
  cbBTC: "#F7931A",
  WBTC: "#F7931A",
  "1INCH": "#072341",
};

function getTokenColor(symbol?: string): string {
  if (!symbol) return "#6B7280";
  return TOKEN_COLORS[symbol] ?? "#6B7280";
}

function TokenBalanceBar({ token0Symbol, token1Symbol, percent0 }: { token0Symbol?: string; token1Symbol?: string; percent0: number }) {
  if (percent0 >= 99.5)
    return (
      <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-muted">
        <div className="h-full w-full rounded-full" style={{ backgroundColor: getTokenColor(token0Symbol) }} />
      </div>
    );
  if (percent0 <= 0.5)
    return (
      <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-muted">
        <div className="h-full w-full rounded-full" style={{ backgroundColor: getTokenColor(token1Symbol) }} />
      </div>
    );
  return (
    <div className="flex h-1.5 w-full gap-0.5 rounded-full overflow-hidden" role="progressbar" aria-valuenow={Math.round(percent0)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full" style={{ width: `${percent0}%`, backgroundColor: getTokenColor(token0Symbol) }} />
      <div className="h-full rounded-full" style={{ width: `${100 - percent0}%`, backgroundColor: getTokenColor(token1Symbol) }} />
    </div>
  );
}

function StatusDot({ oor }: { oor: boolean }) {
  if (!oor) return null;
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0">
      <circle cx="4" cy="4" r="4" fill="currentColor" fillOpacity={0.4} className="text-red-500" />
      <circle cx="4" cy="4" r="2" fill="currentColor" className="text-red-500" />
    </svg>
  );
}

export function AquaPositionCard({ position }: { position: EnrichedAquaPosition }) {
  const pair = getPairLabel(position);
  const fee = getFeeLabel(position);
  const apy = getApy(position);
  const sizeUsd = getSizeUsd(position);
  const oor = position.isOutOfRange;
  const percent0 = getPercent0(position);
  const t0Sym = position.tokens?.[0]?.symbol;
  const t1Sym = position.tokens?.[1]?.symbol;
  const t0Usd = getTokenUsd(position.tokens[0]);
  const t1Usd = getTokenUsd(position.tokens[1]);

  const lower = position.priceRange?.lower;
  const upper = position.priceRange?.upper;

  return (
    <Card
      className="group relative flex flex-col gap-0 p-4 rounded-xl border border-border/50 bg-card min-h-[170px] transition-all duration-200 hover:border-border hover:bg-card/80 hover:-translate-y-0.5 hover:shadow-[var(--shadow-card)]"
      role="article"
      aria-label={`${pair} Aqua strategy ${position.strategyHash.slice(0, 8)}`}
    >
      <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
        {oor ? (
          <Badge variant="destructive" className="rounded-md px-2 py-0.5 text-[10px] font-medium">
            Out of Range
          </Badge>
        ) : (
          <Badge className="rounded-md bg-green-500/15 text-green-600 dark:text-green-400 border-transparent px-2 py-0.5 text-[10px] font-medium">
            In Range
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2 mb-3 pr-24">
        <div className="flex -space-x-1">
          <TokenIcon token={position.tokens?.[0] as never} size={20} />
          <TokenIcon token={position.tokens?.[1] as never} size={20} />
        </div>
        <span className="text-sm font-medium tracking-tight truncate flex items-center gap-1.5">
          <StatusDot oor={oor} />
          {pair}
        </span>
        {fee !== "—" && (
          <Badge variant="muted" className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground border-transparent">
            {fee}
          </Badge>
        )}
      </div>

      <div className="flex items-baseline justify-between mb-3">
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
            Size
          </div>
          <div className="text-xs text-muted-foreground mt-1 font-medium">
            {sizeUsd !== null ? formatUSD(sizeUsd) : "—"}
          </div>
        </div>
      </div>

      {(lower !== undefined || upper !== undefined) && (
        <div className="text-[11px] text-muted-foreground/60 mb-2">
          Range: {lower != null ? String(lower) : "—"} → {upper != null ? String(upper) : "—"}
        </div>
      )}

      <div className="mt-auto space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: getTokenColor(t0Sym) }} />
            {t0Sym ?? "TOKEN0"} · {formatUSD(t0Usd)}
          </span>
          <span className="flex items-center gap-1">
            {formatUSD(t1Usd)} · {t1Sym ?? "TOKEN1"}
            <span className="size-1.5 rounded-full" style={{ backgroundColor: getTokenColor(t1Sym) }} />
          </span>
        </div>
        <TokenBalanceBar token0Symbol={t0Sym} token1Symbol={t1Sym} percent0={percent0} />
      </div>
    </Card>
  );
}
