import { memo } from "react";
import { Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StrategyCard } from "@/components/aqua/strategy-card";
import type { TopPosition } from "@/hooks/use-top-positions";

type TopPositionCardProps = {
  position: TopPosition;
  rank: number;
  onDeploy?: (pos: TopPosition) => void;
};

function tokenUsd(t: TopPosition["tokens"][number]): number {
  const w: any = (t as any)?.wallet?.balance;
  if (w && typeof w.usd === "number" && w.usd > 0) return w.usd;
  const bal: any = (t as any)?.currentBalance;
  if (bal && typeof bal === "object" && typeof bal.usd === "number") return bal.usd ?? 0;
  return 0;
}

function TopPositionCardInner({ position, rank, onDeploy }: TopPositionCardProps) {
  const t0 = position.tokens?.[0];
  const t1 = position.tokens?.[1];
  const pair = `${t0?.symbol ?? t0?.address?.slice(0, 6) ?? "TOKEN0"} / ${
    t1?.symbol ?? t1?.address?.slice(0, 6) ?? "TOKEN1"
  }`;
  const c = position.classification;
  const fee =
    c && typeof c === "object" && "feePercent" in (c as Record<string, unknown>)
      ? `${(c as any).feePercent}%`
      : "0.05%";
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
  const u0 = tokenUsd(t0);
  const u1 = tokenUsd(t1);
  const hasBreakdown = u0 + u1 > 0;
  const sizeUsd = hasBreakdown ? u0 + u1 : 0;
  const explorer =
    position.chainId === 1
      ? "https://etherscan.io"
      : position.chainId === 4663
        ? "https://robinhoodchain.blockscout.com"
        : "https://basescan.org";

  const handleDeploy = () => {
    const a0 = t0?.address;
    const a1 = t1?.address;
    if (a0 && a1) {
      const cid = position.chainId ?? 8453;
      window.open(`https://1inch.com/id/aqua/overview/create?lt=${cid}:${a0}&gt=${cid}:${a1}`, "_blank");
    }
    onDeploy?.(position);
  };

  return (
    <StrategyCard
      pair={pair}
      tokens={[
        { symbol: t0?.symbol, logoURI: t0?.logoURI, address: t0?.address ?? "", usd: u0 },
        { symbol: t1?.symbol, logoURI: t1?.logoURI, address: t1?.address ?? "", usd: u1 },
      ]}
      fee={fee}
      apy={apy}
      volume={volume}
      sizeUsd={sizeUsd}
      showBreakdown={hasBreakdown}
      rank={rank}
      headerRight={
        <a
          href={`${explorer}/address/${position.maker}`}
          target="_blank"
          rel="noopener noreferrer"
          title={position.maker}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
        >
          {position.maker.slice(0, 6)}…{position.maker.slice(-4)}
        </a>
      }
      corner={
        rank === 1 ? (
          <div className="absolute -top-px -right-px">
            <Badge className="flex items-center gap-1 rounded-bl-xl rounded-tr-xl bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground border-transparent rounded-tl-none rounded-br-none">
              <Trophy className="size-3" aria-hidden="true" />
              Top
            </Badge>
          </div>
        ) : undefined
      }
      footer={
        <Button variant="default" size="sm" className="w-full" onClick={handleDeploy}>
          Deploy
        </Button>
      }
    />
  );
}

export const TopPositionCard = memo(TopPositionCardInner);
