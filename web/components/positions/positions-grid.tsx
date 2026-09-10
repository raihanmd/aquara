"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { base } from "wagmi/chains";
import type { Address } from "viem";
import { useDelegation } from "@/hooks/use-delegation";
import { useMyAquaPositions } from "@/hooks/use-my-aqua-positions";
import { QUIRKY_MESSAGES, AQUA } from "@/lib/config";
import { TopPositions } from "@/components/aqua/top-positions";
import { SharedCapital } from "@/components/aqua/shared-capital";
import { AgentActivity } from "@/components/aqua/agent-activity";
import { AquaPositionCard } from "./aqua-position-card";
import { DelegationStepper } from "@/components/delegation/delegation-stepper";
import { DeployDialog } from "@/components/aqua/deploy-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

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

export function PositionsGrid() {
  const { positions, isLoading, error, effectiveMaker, refresh } =
    useMyAquaPositions();
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
  const [rangeMap, setRangeMap] = useState<
    Record<string, { min: string; max: string }>
  >({});
  const [ageMap, setAgeMap] = useState<Record<string, string>>({});
  const [allowMap, setAllowMap] = useState<Record<string, string>>({});
  const [signalMap, setSignalMap] = useState<
    Record<string, { eligible: boolean; headline: string; reasons: string[]; verdict: string }>
  >({});
  const isDelegated = delegationStatus === "delegated";

  const publicClient = usePublicClient({ chainId: base.id });

  useEffect(() => {
    if (!delegateOpen) checkDelegation();
  }, [delegateOpen, checkDelegation]);

  const fetchModes = useCallback(() => {
    if (!effectiveMaker) return Promise.resolve();
    return fetch(`/api/strategies?maker=${effectiveMaker}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        const r: Record<string, { min: string; max: string }> = {};
        const a: Record<string, string> = {};
        for (const row of rows ?? []) {
          if (!row?.strategyHash) continue;
          const key = String(row.strategyHash).toLowerCase();
          if (row.priceMin && row.priceMax)
            r[key] = { min: row.priceMin, max: row.priceMax };
          if (row.createdAt) a[key] = String(row.createdAt);
        }
        setRangeMap(r);
        setAgeMap(a);
      })
      .catch(() => {});
  }, [effectiveMaker]);

  useEffect(() => {
    fetchModes();
  }, [fetchModes]);

  const fetchSignals = useCallback(() => {
    if (!effectiveMaker) return Promise.resolve();
    return fetch(`/api/rotation/signal?maker=${effectiveMaker}`)
      .then((r) => (r.ok ? r.json() : { signals: [] }))
      .then((j) => {
        const m: Record<string, { eligible: boolean; headline: string; reasons: string[]; verdict: string }> = {};
        for (const s of j?.signals ?? []) {
          if (!s?.strategyHash) continue;
          m[String(s.strategyHash).toLowerCase()] = {
            eligible: s.eligible === true,
            headline: String(s.headline ?? ""),
            reasons: Array.isArray(s.reasons) ? s.reasons.map(String) : [],
            verdict: String(s.verdict ?? ""),
          };
        }
        setSignalMap(m);
      })
      .catch(() => {});
  }, [effectiveMaker]);

  // Re-resolve signals whenever the position list itself changes (deploy,
  // close, refresh). Depending only on onDone wiring left fresh positions
  // without a verdict until a manual reload.
  const positionCount = positions.length;
  useEffect(() => {
    fetchSignals();
  }, [fetchSignals, positionCount]);

  useEffect(() => {
    if (!effectiveMaker || !publicClient || positions.length === 0) return;
    const toks = [
      ...new Set(
        positions
          .flatMap((p) =>
            ((p as any)?.tokens ?? []).map((t: any) =>
              String(t?.address ?? "").toLowerCase(),
            ),
          )
          .filter(Boolean),
      ),
    ];
    if (toks.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = (await publicClient.multicall({
          contracts: toks.map((t) => ({
            address: t as Address,
            abi: [
              {
                name: "allowance",
                type: "function",
                stateMutability: "view",
                inputs: [
                  { name: "owner", type: "address" },
                  { name: "spender", type: "address" },
                ],
                outputs: [{ type: "uint256" }],
              },
            ] as const,
            functionName: "allowance",
            args: [effectiveMaker as Address, AQUA as Address],
          })),
        })) as any[];
        if (cancelled) return;
        const m: Record<string, string> = {};
        res.forEach((r, k) => {
          if (r?.status === "success")
            m[toks[k]] = (r.result as bigint).toString();
        });
        setAllowMap(m);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveMaker, publicClient, positions]);

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
                <Button
                  onClick={() => revoke()}
                  disabled={isRevoking}
                  variant="ghost"
                  size="sm"
                  className="group rounded-full bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-destructive/10 hover:text-destructive"
                >
                  <span className="size-1.5 rounded-full bg-current group-hover:bg-current" />
                  <span className="group-hover:hidden">
                    {isRevoking ? "Revoking…" : "Agent active"}
                  </span>
                  <span className="hidden group-hover:inline">
                    {isRevoking ? "Revoking…" : "Deactivate"}
                  </span>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <TopPositions limit={6} />

      <div className="mt-8 space-y-4">
        <div className="flex items-center justify-between">
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
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="flex flex-col gap-0 px-4 pt-3 pb-3 rounded-xl border border-border/50 bg-card w-full"
              >
                <div className="flex items-center justify-between mb-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-5 w-16 rounded-md" />
                </div>
                {[0, 1].map((r) => (
                  <div key={r} className="flex items-center gap-2 py-1.5">
                    <Skeleton className="size-4.5 rounded-full" />
                    <Skeleton className="h-3.5 w-16" />
                    <Skeleton className="h-3.5 w-12 ml-auto" />
                  </div>
                ))}
                <div className="flex items-center gap-4 mt-2">
                  <Skeleton className="h-3.5 w-14" />
                  <Skeleton className="h-3.5 w-14" />
                  <Skeleton className="h-3.5 w-14" />
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
          <SharedCapital positions={positions} />
        )}

        {!isLoading && !error && positions.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
            {slots.map((slot, idx) => {
              if (slot.type === "position") {
                const hashKey = (
                  slot.position.strategyHash ?? ""
                ).toLowerCase();
                const toks = (slot.position as any)?.tokens ?? [];
                const rawOf = (t: any) => {
                  try {
                    return BigInt(
                      String(
                        t?.currentBalance?.raw ?? t?.walletBalance?.raw ?? "0",
                      ),
                    );
                  } catch {
                    return 0n;
                  }
                };
                const allowOk = (t: any) => {
                  const v = allowMap[String(t?.address ?? "").toLowerCase()];
                  if (v === undefined) return null;
                  try {
                    return BigInt(v) > 0n;
                  } catch {
                    return null;
                  }
                };
                const a0 = allowOk(toks[0]);
                const a1 = allowOk(toks[1]);

                const rg = rangeMap[hashKey];
                let rangeLabel: string | null = null;
                if (rg && toks.length >= 2) {
                  const dOf = (t: any) => t?.decimals ?? t?.meta?.decimals;
                  const d0 = dOf(toks[0]);
                  const d1 = dOf(toks[1]);
                  if (d0 !== undefined && d1 !== undefined) {
                    const hiIs0 =
                      String(toks[0]?.address ?? "").toLowerCase() >
                      String(toks[1]?.address ?? "").toLowerCase();
                    const decHi = hiIs0 ? d0 : d1;
                    const decLo = hiIs0 ? d1 : d0;
                    const hHiPerLo = (v: string) =>
                      (Number(v) * 10 ** (decLo - decHi)) / 1e18;
                    const symOf = (t: any) => t?.symbol ?? "";
                    const hiTok = toks[hiIs0 ? 0 : 1];
                    const loTok = toks[hiIs0 ? 1 : 0];
                    const isStable = (t: any) =>
                      [
                        "USDC",
                        "USDT",
                        "DAI",
                        "USDBC",
                        "EURC",
                        "LUSD",
                        "FRAX",
                      ].includes(String(t?.symbol ?? "").toUpperCase());
                    const quoteHi = isStable(hiTok) || !isStable(loTok);
                    const toDisp = (v: string) => {
                      const h = hHiPerLo(v);
                      if (!isFinite(h) || h <= 0) return "?";
                      const q = quoteHi ? h : 1 / h;
                      if (!isFinite(q) || q <= 0) return "?";
                      return q < 0.01
                        ? q.toFixed(6)
                        : q.toLocaleString("en-US", {
                            notation: "compact",
                            maximumFractionDigits: 2,
                          });
                    };
                    const symQ = quoteHi ? hiTok?.symbol : loTok?.symbol;
                    rangeLabel = quoteHi
                      ? `${toDisp(rg.min)}–${toDisp(rg.max)}${symQ ? ` ${symQ}` : ""}`
                      : `${toDisp(rg.max)}–${toDisp(rg.min)}${symQ ? ` ${symQ}` : ""}`;
                  }
                }
                return (
                  <AquaPositionCard
                    key={slot.position.strategyHash + idx}
                    position={slot.position}
                    rangeLabel={rangeLabel}
                    signal={signalMap[hashKey] ?? null}
                    deployedAt={ageMap[hashKey] ?? null}
                    onClosed={() => {
                      refresh();
                      fetchSignals();
                    }}
                  />
                );
              }
            })}
          </div>
        )}

        {!isLoading && !error && effectiveMaker && (
          <AgentActivity maker={effectiveMaker} />
        )}
      </div>

      <DelegationStepper
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
        mode={positions.map((p) => p.strategyHash)}
      />
      <DeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        onDone={() => {
          refresh();
          fetchModes();
          fetchSignals();
        }}
      />
    </div>
  );
}
