import { memo } from "react";
import { Trophy, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatUSD, formatAPY, getPairLabel, getFeeLabel } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TokenIcon } from "./token-icon";
import type { TopPosition } from "@/hooks/use-top-positions";

type TopPositionCardProps = {
  position: TopPosition;
  rank: number;
  onDeploy?: (pos: TopPosition) => void;
};

function TopPositionCardInner({
  position,
  rank,
  onDeploy,
}: TopPositionCardProps) {
  const pair = getPairLabel(position);
  const fee = getFeeLabel(position);
  const apy =
    position.performance?.fees?.last24h?.apy ??
    position.performance?.fees?.last7d?.apy ??
    position.performance?.fees?.last30d?.apy ??
    null;
  const volume =
    position.performance?.volume?.last24h?.usd ??
    position.performance?.volume?.last7d?.usd ??
    position.performance?.volume?.last30d?.usd ??
    null;
  const isTop = rank === 1;

  return (
    <Card
      className={cn(
        "group relative flex flex-col gap-0 p-4 rounded-xl border border-border/50 bg-card min-h-[188px]",
        "transition-all duration-200",
        "hover:border-border hover:bg-card/80 hover:-translate-y-0.5 hover:shadow-(--shadow-card)",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      tabIndex={0}
      role="article"
      aria-label={`${pair} strategy rank ${rank}`}
    >
      <div className="flex items-center gap-3 mb-3">
        <Badge
          variant="default"
          className="flex size-6 shrink-0 items-center justify-center rounded-full p-0 text-xs font-semibold bg-primary text-primary-foreground"
          aria-hidden="true"
        >
          {rank}
        </Badge>
        <div className="flex -space-x-1">
          <TokenIcon token={position.tokens?.[0]} size={20} />
          <TokenIcon token={position.tokens?.[1]} size={20} />
        </div>
        <span className="text-sm font-medium tracking-tight truncate">
          {pair}
        </span>
        <Badge
          variant="muted"
          className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground border-transparent"
        >
          {fee}
        </Badge>
      </div>

      <div className="flex items-baseline justify-between mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            APY (24h)
          </div>
          <div className="text-lg font-semibold tracking-tight mt-0.5 flex items-center gap-1">
            <TrendingUp className="size-3.5 text-primary" aria-hidden="true" />
            {formatAPY(apy)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
            Volume (24h)
          </div>
          <div className="text-xs text-muted-foreground mt-1 font-medium">
            {formatUSD(volume)}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mb-3 text-xs text-muted-foreground/60">
        <span>maker: </span>
        <a
          href={`https://basescan.org/address/${position.maker}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono hover:text-foreground transition-colors truncate"
          onClick={(e) => e.stopPropagation()}
        >
          {position.maker.slice(0, 6)}…{position.maker.slice(-4)}
        </a>
      </div>

      <div className="mt-auto">
        <Button
          variant="default"
          size="sm"
          className="w-full"
          onClick={() => {
            const t0 = position.tokens?.[0]?.address;
            const t1 = position.tokens?.[1]?.address;
            const cid = position.chainId ?? 8453;
            if (t0 && t1) {
              const url = `https://1inch.com/aqua/overview/create?lt=${cid}:${t0}&gt=${cid}:${t1}`;
              window.open(url, "_blank");
            }
            onDeploy?.(position);
          }}
        >
          Deploy
        </Button>
      </div>

      {isTop && (
        <div className="absolute -top-px -right-px">
          <Badge className="flex items-center gap-1 rounded-bl-xl rounded-tr-xl bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground border-transparent rounded-tl-none rounded-br-none">
            <Trophy className="size-3" aria-hidden="true" />
            Top
          </Badge>
        </div>
      )}
    </Card>
  );
}

export const TopPositionCard = memo(TopPositionCardInner);
