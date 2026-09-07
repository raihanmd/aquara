"use client";

import { LayersIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatUSD } from "@/lib/format";
import { computeShareMetrics, type TokenShare } from "@/lib/aqua-metrics";
import type { EnrichedAquaPosition } from "@/hooks/use-my-aqua-positions";

function ShareBar({ token }: { token: TokenShare }) {
  const pct =
    token.quotedUsd > 0
      ? Math.min(100, (token.walletUsd / token.quotedUsd) * 100)
      : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{token.symbol}</span>
        <span className="text-[11px] text-muted-foreground">
          {formatUSD(token.quotedUsd)} quoted · {formatUSD(token.walletUsd)} in
          wallet
        </span>
      </div>
      <div
        className="mt-1 flex h-1.5 w-full rounded-full overflow-hidden bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${token.symbol} wallet coverage`}
      >
        <div
          className={
            token.underfunded
              ? "h-full rounded-full bg-amber-500"
              : "h-full rounded-full bg-primary"
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      {token.underfunded && (
        <div className="mt-1 text-[11px] text-amber-600">
          Underfunded - fills pause until you top up {token.symbol}.
        </div>
      )}
    </div>
  );
}

export function SharedCapital({
  positions,
}: {
  positions: EnrichedAquaPosition[];
}) {
  if (positions.length === 0) return null;
  const m = computeShareMetrics(positions);

  return (
    <section aria-labelledby="shared-capital-heading">
      <div className="flex items-center gap-2 mb-3">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <LayersIcon className="size-3.5" aria-hidden="true" />
        </span>
        <h2
          id="shared-capital-heading"
          className="text-sm font-semibold tracking-tight"
        >
          One balance,{" "}
          <span className="text-primary">{positions.length} positions</span>
        </h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          SLR {m.slr != null ? `${m.slr.toFixed(1)}×` : "-"}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="rounded-xl border border-border/50 bg-card px-4 py-6">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            Shared ratio
          </div>
          <div className="text-4xl font-semibold tracking-tight mt-1 text-primary">
            {m.slr != null ? `${m.slr.toFixed(1)}×` : "-"}
          </div>
          <div className="mt-3 space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                In wallet
              </span>
              <span className="text-sm font-semibold">
                {formatUSD(m.totalWalletUsd)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                Quoted (TVU)
              </span>
              <span className="text-sm font-semibold">
                {formatUSD(m.totalQuotedUsd)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">Filling</span>
              <span className="text-sm font-semibold">
                {m.activeCount}/{positions.length}
              </span>
            </div>
          </div>
        </Card>

        <Card className="rounded-xl border border-border/50 bg-card px-4 py-6">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium mb-2">
            Wallet coverage per token
          </div>
          <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
            {m.tokens.map((t) => (
              <ShareBar key={t.symbol} token={t} />
            ))}
          </div>
        </Card>
      </div>
    </section>
  );
}
