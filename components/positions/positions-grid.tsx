"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useDelegation } from "@/hooks/use-delegation";
import { useMyAquaPositions } from "@/hooks/use-my-aqua-positions";
import { QUIRKY_MESSAGES } from "@/lib/config";
import { TopPositions } from "@/components/aqua/top-positions";
import { SharedCapital } from "@/components/aqua/shared-capital";
import { AgentActivity } from "@/components/aqua/agent-activity";
import { AquaPositionCard } from "./aqua-position-card";
import { DelegationStepper } from "@/components/delegation/delegation-stepper";
import { DeployDialog } from "@/components/aqua/deploy-dialog";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 9;
const GRID_SLOTS = 9;

function formatUSD(total: number): string {
  if (total === 0) return "$0.00";
  if (total >= 1_000_000) return `$${(total / 1_000_000).toFixed(2)}M`;
  if (total >= 1_000) return `$${(total / 1_000).toFixed(2)}K`;
  return `$${total.toFixed(2)}`;
}

function tokenUsd(t: { currentBalance?: unknown }): number {
  const bal = t.currentBalance as { usd?: number | null } | string | undefined;
  if (bal && typeof bal === "object" && typeof bal.usd === "number")
    return bal.usd ?? 0;
  return 0;
}

function netSizeUsd(
  positions: { tokens: { currentBalance?: unknown }[] }[],
): number {
  let total = 0;
  for (const p of positions) {
    for (const t of p.tokens ?? []) total += tokenUsd(t);
  }
  return total;
}

/**
 * CRE rebalance reference - batch [approve token0, approve token1, ship(app, strategy, tokens, amounts)]
 * Aqua ship requires both tokens approved to Aqua (0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) before ship.
 * Example deployed: WETH 0x4200000000000000000000000000000000000006 + wstETH 0xc1CBa3fcea344f92D9239c08C0568F6F2f0EE452
 * tx 0xb8de0f... on Base chain 8453. OOR position at 0xCbAfD2B1c1309b1701E9ef7e4d38C93425A6b61A.
 */

export function PositionsGrid() {
  const { positions, isLoading, error, effectiveMaker } = useMyAquaPositions();
  const {
    status: delegationStatus,
    revoke,
    isSubmitting: isRevoking,
    checkDelegation,
  } = useDelegation();
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [modeMap, setModeMap] = useState<Record<string, string>>({});
  const isDelegated = delegationStatus === "delegated";

  useEffect(() => {
    if (!delegateOpen) checkDelegation();
  }, [delegateOpen, checkDelegation]);

  useEffect(() => {
    if (!effectiveMaker) return;
    fetch(`/api/strategies?maker=${effectiveMaker}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        const m: Record<string, string> = {};
        for (const row of rows ?? []) {
          if (row?.strategyHash)
            m[String(row.strategyHash).toLowerCase()] = row.mode;
        }
        setModeMap(m);
      })
      .catch(() => {});
  }, [effectiveMaker]);

  useEffect(() => {
    if (!isDelegated || !effectiveMaker) return;
    fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: effectiveMaker, chainId: 8453 }),
    }).catch(() => {});
  }, [isDelegated, effectiveMaker]);

  useEffect(() => {
    if (positions.length === 0) {
      if (isLoading) return;
      setMessage(
        QUIRKY_MESSAGES[Math.floor(Math.random() * QUIRKY_MESSAGES.length)],
      );
      return;
    }

    const oor = positions.filter((p) => p.isOutOfRange);
    if (oor.length > 0) {
      setMessage(
        `${oor.length} of ${positions.length} position${positions.length !== 1 ? "s" : ""} out of range. Aquara is on it.`,
      );
    } else {
      setMessage(
        `All ${positions.length} position${positions.length !== 1 ? "s" : ""} in range. Compounding quietly.`,
      );
    }
  }, [positions, isLoading]);

  const totalPages = Math.max(1, Math.ceil((positions.length + 1) / PAGE_SIZE));
  const startIdx = page * PAGE_SIZE;
  const pagePositions = positions.slice(startIdx, startIdx + PAGE_SIZE);
  const netSize = formatUSD(netSizeUsd(positions));
  const oorCount = positions.filter((p) => p.isOutOfRange).length;

  type Slot = { type: "position"; position: (typeof positions)[0] };

  const slots: Slot[] = [];
  for (let i = 0; i < GRID_SLOTS; i++) {
    if (i < pagePositions.length) {
      slots.push({ type: "position", position: pagePositions[i] });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 flex flex-col justify-start py-24">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
            Aquara
          </div>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            {message}
          </h1>
          {oorCount > 0 && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-warning px-2.5 py-1 text-[11px] font-medium text-warning-foreground">
              <span className="size-1.5 rounded-full bg-current" />
              {oorCount} need{oorCount === 1 ? "s" : ""} attention
            </div>
          )}
        </div>

        {!isLoading && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium">
                Net Size
              </div>
              <div className="text-2xl font-semibold tracking-tight mt-0.5">
                {netSize}
              </div>
            </div>

            {delegationStatus === "unknown" ||
            delegationStatus === "checking" ? (
              <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-2 text-xs text-muted-foreground">
                <span className="size-3 rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60 animate-spin" />
                Checking pass…
              </div>
            ) : !isDelegated ? (
              <Button
                onClick={() => setDelegateOpen(true)}
                variant="default"
                className="rounded-full"
              >
                Delegate to agent
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => setDeployOpen(true)}
                  variant="default"
                  className="rounded-full"
                >
                  Deploy strategy
                </Button>
                <button
                  onClick={() => revoke()}
                  disabled={isRevoking}
                  className="group flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 cursor-pointer"
                >
                  <span className="size-1.5 rounded-full bg-current group-hover:bg-current" />
                  <span className="group-hover:hidden">
                    {isRevoking ? "Revoking…" : "Agent active"}
                  </span>
                  <span className="hidden group-hover:inline">
                    {isRevoking ? "Revoking…" : "Deactivate"}
                  </span>
                </button>
              </div>
            )}
          </div>
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
              Check the API key on the server and try again.
            </p>
          </div>
        )}

        {!isLoading && !error && positions.length === 0 && (
          <div className="rounded-xl border border-border/50 bg-card p-8 text-center">
            <p className="text-sm font-medium">No Aqua positions found</p>
          </div>
        )}

        {!isLoading && !error && positions.length > 0 && (
          <div className="mb-6">
            <SharedCapital positions={positions} />
          </div>
        )}

        {!isLoading && !error && positions.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
            {slots.map((slot, idx) => {
              if (slot.type === "position") {
                return (
                  <AquaPositionCard
                    key={slot.position.strategyHash + idx}
                    position={slot.position}
                    mode={
                      modeMap[
                        (slot.position.strategyHash ?? "").toLowerCase()
                      ] ?? null
                    }
                  />
                );
              }
            })}
          </div>
        )}

        {!isLoading && !error && effectiveMaker && (
          <div>
            <AgentActivity maker={effectiveMaker} />
          </div>
        )}
      </div>

      <DelegationStepper
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
        mode={positions.map((p) => p.strategyHash)}
      />
      <DeployDialog open={deployOpen} onOpenChange={setDeployOpen} />
    </div>
  );
}
