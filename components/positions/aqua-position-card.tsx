"use client";

import { useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { base } from "wagmi/chains";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { Loader2, ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StrategyCard } from "@/components/aqua/strategy-card";
import { cn } from "@/lib/utils";
import { AQUA, AQUA_ROUTER } from "@/lib/config";
import type { EnrichedAquaPosition } from "@/hooks/use-my-aqua-positions";
import Link from "next/link";

const DOCK_ABI = [
  {
    name: "dock",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "tokens", type: "address[]" },
    ],
    outputs: [],
  },
] as const;

function getPairLabel(pos: EnrichedAquaPosition): string {
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

function getFeeLabel(pos: EnrichedAquaPosition): string | null {
  const c = pos.classification;
  if (typeof c === "string" && c.includes("%")) return c;
  if (c && typeof c === "object") {
    const rec = c as Record<string, unknown>;
    if (typeof rec.fee === "string") return rec.fee as string;
    if (typeof rec.fee === "number")
      return `${((rec.fee as number) / 10000).toFixed(2)}%`;
    if (typeof rec.feePercent === "string") return rec.feePercent as string;
    if (typeof rec.feePercent === "number")
      return `${(rec.feePercent as number).toFixed(2)}%`;
    if (typeof rec.feeTier === "number")
      return `${((rec.feeTier as number) / 10000).toFixed(2)}%`;
  }
  return null;
}

function tokenUsd(t: EnrichedAquaPosition["tokens"][number]): number {
  const bal: any = (t as any).currentBalance;
  if (bal && typeof bal === "object" && typeof bal.usd === "number") return bal.usd ?? 0;
  return 0;
}

function earnedUsd(tokens: EnrichedAquaPosition["tokens"]): number | null {
  let sum = 0;
  let ok = false;
  for (const t of tokens ?? []) {
    const b: any = (t as any)?.currentBalance;
    const ib: any = (t as any)?.initialBalance;
    const cRaw = b && typeof b === "object" ? b.raw : null;
    const iRaw = ib && typeof ib === "object" ? ib.raw : null;
    const cUsd = b && typeof b === "object" && typeof b.usd === "number" ? (b.usd as number) : null;
    if (cRaw == null || iRaw == null || cUsd == null) continue;
    try {
      const c = Number(BigInt(String(cRaw)));
      const i = Number(BigInt(String(iRaw)));
      if (!(c > 0)) continue;
      sum += cUsd - cUsd * (i / c);
      ok = true;
    } catch {
      continue;
    }
  }
  return ok ? sum : null;
}

function coverage(t: any): number | null {
  const cur = t?.currentBalance?.raw;
  const wal = t?.walletBalance?.raw ?? t?.wallet?.balance?.raw;
  if (cur === undefined || wal === undefined || wal === null) return null;
  try {
    const c = BigInt(String(cur));
    const w = BigInt(String(wal));
    if (w === 0n) return null;
    return Number((c * 10000n) / w) / 100;
  } catch {
    return null;
  }
}

export function AquaPositionCard({
  position,
  mode,
  fillable,
  allowanceOk,
  rangeLabel,
  onClosed,
}: {
  position: EnrichedAquaPosition;
  mode?: string | null;
  fillable?: boolean;
  allowanceOk?: boolean | null;
  rangeLabel?: string | null;
  onClosed?: () => void;
}) {
  const oor = position.isOutOfRange;
  const illiquid = (position as any).isIlliquid === true;
  const u0 = tokenUsd(position.tokens[0]);
  const u1 = tokenUsd(position.tokens[1]);
  const hasBreakdown = u0 + u1 > 0;
  const sizeUsd = hasBreakdown ? u0 + u1 : 0;

  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const closePosition = async () => {
    if (!address || !walletClient || !publicClient) {
      setCloseError("Connect wallet first");
      return;
    }
    setClosing(true);
    setCloseError(null);
    try {
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
      const data = encodeFunctionData({
        abi: DOCK_ABI,
        functionName: "dock",
        args: [
          AQUA_ROUTER,
          position.strategyHash as Hex,
          (position.tokens ?? []).map((t) => t.address as Address),
        ],
      });
      const hash = await walletClient.sendTransaction({
        account: address,
        to: AQUA,
        data,
        chain: base,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      onClosed?.();
    } catch (e: any) {
      setCloseError(e?.shortMessage || e?.message || "Close failed");
    } finally {
      setClosing(false);
    }
  };

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
      earned={earnedUsd(position.tokens)}
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
          {illiquid ? (
            <Badge className="rounded-md bg-amber-500/15 text-amber-600 border-transparent px-2 py-0.5 text-[10px] font-medium">
              Illiquid
            </Badge>
          ) : oor ? (
            <Badge variant="destructive" className="rounded-md px-2 py-0.5 text-[10px] font-medium">
              Out of Range
            </Badge>
          ) : (
            <Badge className="rounded-md bg-green-500/15 text-green-600 border-transparent px-2 py-0.5 text-[10px] font-medium">
              In Range
            </Badge>
          )}
        </>
      }
      extra={
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              title={
                fillable
                  ? allowanceOk === false
                    ? "Balances exist but Aqua allowance is missing - fills will revert"
                    : "Fillable"
                  : "Not fillable"
              }
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 text-[10px] font-medium",
                fillable && allowanceOk !== false
                  ? "bg-green-500/15 text-green-600"
                  : fillable
                    ? "bg-amber-500/15 text-amber-600"
                    : "bg-muted text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  fillable && allowanceOk !== false
                    ? "bg-green-500"
                    : fillable
                      ? "bg-amber-500"
                      : "bg-muted-foreground/40",
                )}
              />
              {fillable ? (allowanceOk === false ? "Approve needed" : "Fillable") : "Thin"}
            </span>
            {mode === "aggressive" && (
              <Badge className="rounded-md bg-amber-500/15 text-amber-600 border-transparent px-2 py-0.5 text-[10px] font-medium">
                Aggressive
              </Badge>
            )}
            {rangeLabel && (
              <Badge variant="outline" className="rounded-md px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {rangeLabel}
              </Badge>
            )}
          </div>
          {position.priceRange?.lower !== undefined ||
          position.priceRange?.upper !== undefined ? (
            <div className="text-[11px] text-muted-foreground/60">
              Range:{" "}
              {position.priceRange?.lower != null
                ? String(position.priceRange.lower)
                : "-"}{" "}
              →{" "}
              {position.priceRange?.upper != null
                ? String(position.priceRange.upper)
                : "-"}
            </div>
          ) : null}
        </div>
      }
      footer={
        <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          {closeError ? (
            <div className="text-[11px] text-destructive wrap-break-words">
              {closeError}
            </div>
          ) : (
            <div className="flex justify-between items-center">
              {position.strategyHash && (
                <Link
                  href={`https://1inch.com/aqua/overview/8453/${AQUA_ROUTER}/${position.strategyHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on Aqua"
                  aria-label="View position on Aqua"
                  className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Link>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closePosition}
                disabled={closing}
                className="h-7 rounded-full px-2.5 text-[11px] font-medium text-muted-foreground hover:text-destructive"
              >
                {closing && <Loader2 className="size-3 animate-spin" />}
                {closing ? "Closing…" : "Close position"}
              </Button>
            </div>
          )}
        </div>
      }
    />
  );
}
