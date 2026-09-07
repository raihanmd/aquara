"use client";

import { Badge } from "@/components/ui/badge";
import { StrategyCard } from "@/components/aqua/strategy-card";
import type { EnrichedAquaPosition } from "@/hooks/use-my-aqua-positions";

function getPairLabel(pos: EnrichedAquaPosition): string {
  const t0 = pos.tokens?.[0]?.symbol ?? pos.tokens?.[0]?.address?.slice(0, 6) ?? "TOKEN0";
  const t1 = pos.tokens?.[1]?.symbol ?? pos.tokens?.[1]?.address?.slice(0, 6) ?? "TOKEN1";
  return `${t0} / ${t1}`;
}

function getFeeLabel(pos: EnrichedAquaPosition): string | null {
  const c = pos.classification;
  if (typeof c === "string" && c.includes("%")) return c;
  if (c && typeof c === "object") {
    const rec = c as Record<string, unknown>;
    if (typeof rec.fee === "string") return rec.fee as string;
    if (typeof rec.fee === "number") return `${((rec.fee as number) / 10000).toFixed(2)}%`;
    if (typeof rec.feePercent === "string") return rec.feePercent as string;
    if (typeof rec.feePercent === "number") return `${(rec.feePercent as number).toFixed(2)}%`;
    if (typeof rec.feeTier === "number") return `${((rec.feeTier as number) / 10000).toFixed(2)}%`;
  }
  return null;
}

function tokenUsd(t: EnrichedAquaPosition["tokens"][number]): number {
  const bal: any = (t as any).currentBalance;
  if (bal && typeof bal === "object" && typeof bal.usd === "number") return bal.usd ?? 0;
  return 0;
}

export function AquaPositionCard({
  position,
  mode,
}: {
  position: EnrichedAquaPosition;
  mode?: string | null;
}) {
  const oor = position.isOutOfRange;
  const u0 = tokenUsd(position.tokens[0]);
  const u1 = tokenUsd(position.tokens[1]);
  const hasBreakdown = u0 + u1 > 0;
  const sizeUsd = hasBreakdown ? u0 + u1 : 0;

  return (
    <StrategyCard
      pair={getPairLabel(position)}
      tokens={[
        {
          symbol: position.tokens?.[0]?.symbol,
          logoURI: position.tokens?.[0]?.logoURI,
          address: position.tokens?.[0]?.address ?? "",
          usd: u0,
        },
        {
          symbol: position.tokens?.[1]?.symbol,
          logoURI: position.tokens?.[1]?.logoURI,
          address: position.tokens?.[1]?.address ?? "",
          usd: u1,
        },
      ]}
      fee={getFeeLabel(position)}
      apy={
        position.performance?.fees?.last24h?.apy ??
        position.performance?.fees?.last7d?.apy ??
        position.performance?.fees?.last30d?.apy ??
        position.performance?.fees?.total?.apy ??
        null
      }
      volume={
        position.performance?.volume?.last24h?.usd ??
        position.performance?.volume?.last7d?.usd ??
        position.performance?.volume?.last30d?.usd ??
        null
      }
      sizeUsd={sizeUsd}
      showBreakdown={hasBreakdown}
      badge={
        <>
          {oor ? (
            <Badge variant="destructive" className="rounded-md px-2 py-0.5 text-[10px] font-medium">
              Out of Range
            </Badge>
          ) : (
            <Badge className="rounded-md bg-green-500/15 text-green-600 border-transparent px-2 py-0.5 text-[10px] font-medium">
              In Range
            </Badge>
          )}
          {mode === "aggressive" ? (
            <Badge className="rounded-md bg-amber-500/15 text-amber-600 border-transparent px-2 py-0.5 text-[10px] font-medium">
              Aggressive
            </Badge>
          ) : mode === "conservative" ? (
            <Badge variant="outline" className="rounded-md px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Stable
            </Badge>
          ) : null}
        </>
      }
      extra={
        position.priceRange?.lower !== undefined || position.priceRange?.upper !== undefined ? (
          <div className="text-[11px] text-muted-foreground/60 mb-3">
            Range: {position.priceRange?.lower != null ? String(position.priceRange.lower) : "-"} →{" "}
            {position.priceRange?.upper != null ? String(position.priceRange.upper) : "-"}
          </div>
        ) : undefined
      }
    />
  );
}
