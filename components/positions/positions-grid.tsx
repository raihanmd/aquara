"use client";

import { motion } from "framer-motion";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useDelegation } from "@/hooks/use-delegation";
import {
  useMyAquaPositions,
  DEMO_ADDRESS,
} from "@/hooks/use-my-aqua-positions";
import { QUIRKY_MESSAGES, API_URL } from "@/lib/config";
import { TopPositions } from "@/components/aqua/top-positions";
import { AquaPositionCard } from "./aqua-position-card";
import { DelegationStepper } from "@/components/delegation/delegation-stepper";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 9;
const GRID_SLOTS = 9;

function formatUSD(total: number): string {
  if (total === 0) return "$0.00";
  if (total >= 1_000_000) return `$${(total / 1_000_000).toFixed(2)}M`;
  if (total >= 1_000) return `$${(total / 1_000).toFixed(2)}K`;
  return `$${total.toFixed(2)}`;
}

function formatTotalValue(
  positions: {
    performance?: {
      volume?: {
        last7d?: { usd: number | null };
        last30d?: { usd: number | null };
      };
      fees?: {
        last7d?: { usd?: number | null };
        last30d?: { usd?: number | null };
      };
    } | null;
  }[],
): string {
  let total = 0;
  for (const p of positions) {
    const v =
      p.performance?.volume?.last7d?.usd ??
      p.performance?.volume?.last30d?.usd ??
      p.performance?.fees?.last7d?.usd ??
      p.performance?.fees?.last30d?.usd ??
      0;
    if (typeof v === "number") total += v;
  }
  return formatUSD(total);
}

function estimateDailyYield(
  positions: {
    performance?: {
      fees?: {
        last7d?: { apy: number | null; usd?: number | null };
        last30d?: { apy: number | null; usd?: number | null };
      };
      volume?: {
        last7d?: { usd: number | null };
        last30d?: { usd: number | null };
      };
    } | null;
  }[],
): string {
  let dailyYield = 0;
  for (const p of positions) {
    const feesUsd =
      p.performance?.fees?.last7d?.usd ?? p.performance?.fees?.last30d?.usd;
    const apy =
      p.performance?.fees?.last7d?.apy ?? p.performance?.fees?.last30d?.apy;
    const vol = (p.performance?.volume?.last7d?.usd ??
      p.performance?.volume?.last30d?.usd ??
      0) as number;
    if (typeof feesUsd === "number" && feesUsd > 0) {
      dailyYield += feesUsd / 30;
    } else if (typeof apy === "number" && typeof vol === "number" && vol > 0) {
      dailyYield += (apy / 100 / 365) * vol;
    }
  }
  return formatUSD(dailyYield);
}

/**
 * CRE rebalance reference — batch [approve token0, approve token1, ship(app, strategy, tokens, amounts)]
 * Aqua ship requires both tokens approved to Aqua (0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) before ship.
 * Example deployed: WETH 0x4200000000000000000000000000000000000006 + wstETH 0xc1CBa3fcea344f92D9239c08C0568F6F2f0EE452
 * tx 0xb8de0f... on Base chain 8453. OOR position at 0xCbAfD2B1c1309b1701E9ef7e4d38C93425A6b61A.
 */

export function PositionsGrid() {
  const { address } = useAccount();
  const { positions, isLoading, error, effectiveMaker } = useMyAquaPositions();
  const { status: delegationStatus } = useDelegation();
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  const [delegateOpen, setDelegateOpen] = useState(false);
  const isDelegated = delegationStatus === "delegated";

  useEffect(() => {
    if (positions.length === 0) {
      if (isLoading) return;
      setMessage(
        QUIRKY_MESSAGES[Math.floor(Math.random() * QUIRKY_MESSAGES.length)],
      );
      return;
    }

    const maker = effectiveMaker ?? address ?? DEMO_ADDRESS;
    fetch(`${API_URL}/api/actions?address=${maker}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const actions = Array.isArray(data) ? data : (data?.actions ?? []);
        const today = Date.now() - 24 * 60 * 60 * 1000;
        const rebalances = actions.filter(
          (a: { timestamp: number; type: string; status: string }) =>
            a.timestamp > today &&
            a.type === "rebalance" &&
            a.status === "completed",
        );
        const seen = new Set<string>();
        const uniqueRebalances = rebalances.filter(
          (a: { txHashes?: string[]; id: string }) => {
            const key = a.txHashes?.[0] || a.id;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          },
        );

        if (uniqueRebalances.length > 0) {
          const uniquePositions = new Set(
            uniqueRebalances
              .map(
                (a: { strategyHash?: string; tokenId?: string }) =>
                  a.strategyHash ?? a.tokenId,
              )
              .filter(Boolean),
          );
          setMessage(
            `Rebalanced ${uniquePositions.size} position${uniquePositions.size !== 1 ? "s" : ""} ${uniqueRebalances.length} time${uniqueRebalances.length !== 1 ? "s" : ""} today.`,
          );
        } else {
          const oor = positions.filter((p) => p.isOutOfRange);
          if (oor.length > 0) {
            setMessage(
              `${oor.length} of ${positions.length} position${positions.length !== 1 ? "s" : ""} out of range. On it.`,
            );
          } else {
            setMessage(
              `All ${positions.length} position${positions.length !== 1 ? "s" : ""} in range. Looking good.`,
            );
          }
        }
      })
      .catch(() => {
        const oor = positions.filter((p) => p.isOutOfRange);
        if (oor.length > 0) {
          setMessage(
            `${oor.length} of ${positions.length} position${positions.length !== 1 ? "s" : ""} out of range. On it.`,
          );
        } else {
          setMessage(
            `All ${positions.length} position${positions.length !== 1 ? "s" : ""} in range. Looking good.`,
          );
        }
      });
  }, [address, positions, effectiveMaker, isLoading]);

  const totalPages = Math.max(1, Math.ceil((positions.length + 1) / PAGE_SIZE));
  const startIdx = page * PAGE_SIZE;
  const pagePositions = positions.slice(startIdx, startIdx + PAGE_SIZE);
  const totalValue = formatTotalValue(positions);
  const dailyYield = estimateDailyYield(positions);

  type Slot = { type: "position"; position: (typeof positions)[0] };

  const slots: Slot[] = [];
  for (let i = 0; i < GRID_SLOTS; i++) {
    if (i < pagePositions.length) {
      slots.push({ type: "position", position: pagePositions[i] });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 flex flex-col justify-start py-24 min-h-full">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <motion.p
            animate={{ opacity: 1, x: 0 }}
            initial={{ opacity: 0, x: -6 }}
            transition={{
              delay: 0.15,
              duration: 0.4,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="text-3xl text-foreground font-serif leading-tight"
          >
            {message}
          </motion.p>
        </div>

        {positions.length > 0 && (
          <motion.div
            animate={{ opacity: 1 }}
            initial={{ opacity: 0 }}
            transition={{ delay: 0.3, duration: 0.4 }}
            className="flex items-center gap-3"
          >
            <div className="text-right mr-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
                Yield / Day
              </div>
              <div className="text-lg font-semibold tracking-tight mt-0.5 text-green-500/80">
                {dailyYield}
              </div>
            </div>

            <div className="w-px h-8 bg-border/30 mx-2" />

            <div className="text-right mr-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
                Total Value
              </div>
              <div className="text-2xl font-semibold tracking-tight mt-0.5">
                {totalValue}
              </div>
            </div>

            {!isDelegated && (
              <Button
                onClick={() => setDelegateOpen(true)}
                variant="outline"
                className="border-border/50 bg-card/30 text-muted-foreground hover:bg-muted/40 hover:text-foreground hover:-translate-y-0.5 hover:shadow-(--shadow-card)"
              >
                Delegate All
              </Button>
            )}
          </motion.div>
        )}
      </div>

      <TopPositions limit={6} />

      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-2">
            Your Aqua Positions
            {effectiveMaker && (
              <span className="text-xs font-mono font-normal text-muted-foreground/60">
                {effectiveMaker.slice(0, 6)}…{effectiveMaker.slice(-4)}
              </span>
            )}
          </h2>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                aria-label="Previous page"
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground px-2">
                {page + 1} / {totalPages}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                aria-label="Next page"
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>
          )}
        </div>

        {isLoading && positions.length === 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(GRID_SLOTS)].map((_, i) => (
              <div
                key={i}
                className="h-44 rounded-xl border border-border/50 bg-card"
              >
                <div className="flex h-full items-center justify-center">
                  <div className="size-4 rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60 animate-spin" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive">
              Failed to load Aqua positions: {error}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Check NEXT_PUBLIC_1INCH_API_KEY and try again.
            </p>
          </div>
        )}

        {!isLoading && !error && positions.length === 0 && (
          <div className="rounded-xl border border-border/50 bg-card p-8 text-center">
            <p className="text-sm font-medium">No Aqua positions found</p>
          </div>
        )}

        {!isLoading && !error && positions.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {slots.map((slot, idx) => {
              if (slot.type === "position") {
                return (
                  <AquaPositionCard
                    key={slot.position.strategyHash + idx}
                    position={slot.position}
                  />
                );
              }
            })}
          </div>
        )}
      </div>

      <DelegationStepper
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
        mode={positions.map((p) => p.strategyHash)}
      />
    </div>
  );
}
