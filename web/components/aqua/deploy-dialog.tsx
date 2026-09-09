"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, Controller, FormProvider, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAccount, usePublicClient, useSignMessage } from "wagmi";
import { base } from "wagmi/chains";
import type { Address } from "viem";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTopPositions } from "@/hooks/use-top-positions";
import { useMyAquaPositions } from "@/hooks/use-my-aqua-positions";
import { CapitalSection } from "./deploy-dialog/capital-section";
import { TemplateSection } from "./deploy-dialog/template-section";
import { ManualPairsSection } from "./deploy-dialog/manual-pairs-section";
import {
  formSchema,
  USDC_BASE,
  type FormValues,
  type TokenOpt,
} from "./deploy-dialog/schema";
import { buildDeployMessage } from "@/lib/deploy-auth";
import { cn } from "@/lib/utils";
import Link from "next/link";

export function DeployDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { data: tops } = useTopPositions({
    chainIds: [8453],
    limit: 6,
    sortBy: "volume",
  });
  const { positions } = useMyAquaPositions();

  const [tokens, setTokens] = useState<TokenOpt[]>([]);
  const [balances, setBalances] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const publicClient = usePublicClient({ chainId: base.id });

  const form = useForm<FormValues>({
    resolver: zodResolver(
      formSchema,
    ) as unknown as import("react-hook-form").Resolver<FormValues>,
    defaultValues: {
      capital: USDC_BASE,
      capitalAmount: "",
      templates: [],
      manualPairs: [],
      aggressive: false,
    },
  });

  const fetchedRef = useRef(false);
  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/aqua/tokens?chainIds=8453")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (Array.isArray(j?.items) && j.items.length > 0) {
          setTokens(
            (j.items as TokenOpt[]).map((t) => ({
              ...t,
              address: t.address.toLowerCase(),
            })),
          );
        }
      })
      .catch(() => {
        fetchedRef.current = false;
      });
  }, [open]);

  const BAL_ABI = [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ] as const;

  useEffect(() => {
    if (!open || !address || !publicClient || tokens.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const list = tokens.slice(0, 60);
        const res = await publicClient.multicall({
          contracts: list.map((t) => ({
            address: t.address as Address,
            abi: BAL_ABI,
            functionName: "balanceOf",
            args: [address],
          })),
        });
        if (cancelled) return;
        const m = new Map<string, string>();
        res.forEach((r, i) => {
          if (r.status === "success") {
            m.set(
              list[i].address.toLowerCase(),
              (r.result as bigint).toString(),
            );
          }
        });
        setBalances(m);
      } catch {
        // leave previous balances; dialog stays usable
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, address, publicClient, tokens]);

  const walletMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of positions) {
      for (const t of p.tokens ?? []) {
        const raw: any =
          (t as any)?.walletBalance?.raw ?? (t as any)?.wallet?.balance?.raw;
        if (!raw || String(raw) === "0") continue;
        const key = (t.address ?? "").toLowerCase();
        if (!key || m.has(key)) continue;
        m.set(key, String(raw));
      }
    }
    return m;
  }, [positions]);

  const balanceMap = useMemo(() => {
    const m = new Map(walletMap);
    for (const [k, v] of balances) m.set(k, v);
    return m;
  }, [walletMap, balances]);

  const sortedTokens = useMemo(() => {
    const hasBal = (t: TokenOpt) => {
      const r = balanceMap.get(t.address.toLowerCase());
      return r !== undefined && r !== "0" ? 1 : 0;
    };
    return [...tokens].sort((a, b) => hasBal(b) - hasBal(a));
  }, [tokens, balanceMap]);

  const availableMap = useMemo(() => {
    const allocated = new Map<string, bigint>();
    for (const p of positions) {
      for (const t of (p as any)?.tokens ?? []) {
        const addr = String(t?.address ?? "").toLowerCase();
        const raw = t?.currentBalance?.raw ?? t?.walletBalance?.raw;
        if (!addr || raw === undefined || raw === null) continue;
        try {
          allocated.set(
            addr,
            (allocated.get(addr) ?? 0n) + BigInt(String(raw)),
          );
        } catch {}
      }
    }
    const m = new Map<string, { available: string; allocated: string }>();
    for (const [addr, balRaw] of balanceMap) {
      try {
        const alloc = allocated.get(addr) ?? 0n;
        const avail = BigInt(balRaw) - alloc;
        m.set(addr, {
          available: (avail > 0n ? avail : 0n).toString(),
          allocated: alloc.toString(),
        });
      } catch {}
    }
    return m;
  }, [balanceMap, positions]);

  const [liveSteps, setLiveSteps] = useState<
    Record<number, { stage: string; detail?: string; txHash?: string }>
  >({});

  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [liveSteps, submitError, busy]);

  const aggressive = useWatch({ control: form.control, name: "aggressive" });

  const onSubmit = async (v: FormValues) => {
    if (!address) {
      setSubmitError("Connect wallet first.");
      return;
    }
    const picked = (tops ?? []).filter((p) =>
      v.templates.includes(p.strategyHash),
    );
    const seen = new Set<string>();
    const pairs: { tokenA: string; tokenB: string }[] = [];
    const pushPair = (a?: string, b?: string) => {
      if (!a || !b) return;
      const key = [a.toLowerCase(), b.toLowerCase()].sort().join("|");
      if (a.toLowerCase() === b.toLowerCase() || seen.has(key)) return;
      seen.add(key);
      pairs.push({ tokenA: a, tokenB: b });
    };
    for (const p of picked) {
      pushPair(p.tokens?.[0]?.address, p.tokens?.[1]?.address);
    }
    for (const m of v.manualPairs) {
      pushPair(m.tokenA, m.tokenB);
    }
    if (pairs.length === 0) {
      setSubmitError("Pick at least one template or add a manual pair.");
      return;
    }
    setBusy(true);
    setSubmitError(null);
    setTxHashes([]);
    setLiveSteps({});
    const deployMode = v.aggressive ? "aggressive" : "stable";
    const nonce = String(Date.now());
    const expiry = String(Date.now() + 5 * 60 * 1000);
    let signature: string;
    try {
      signature = await signMessageAsync({
        message: buildDeployMessage({
          maker: address,
          capital: v.capital,
          capitalAmount: v.capitalAmount,
          pairs,
          mode: deployMode,
          nonce,
          expiry,
        }),
      });
    } catch {
      setSubmitError("Signature rejected - deploy cancelled");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/agent/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maker: address,
          capital: v.capital,
          capitalAmount: v.capitalAmount,
          pairs,
          mode: deployMode,
          signature,
          nonce,
          expiry,
        }),
      });
      if (!res.ok && !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error || `Deploy failed (${res.status})`);
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const hashes: string[] = [];
      let doneOk = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.pair !== undefined) {
            setLiveSteps((prev) => ({
              ...prev,
              [evt.pair]: {
                stage: evt.stage,
                detail: evt.detail,
                txHash: evt.txHash,
              },
            }));
            if (evt.txHash && !hashes.includes(evt.txHash)) {
              hashes.push(evt.txHash);
              setTxHashes([...hashes]);
            }
          }
          if (evt.error && !evt.done) {
            throw new Error(evt.error);
          }
          if (evt.done && evt.error) {
            throw new Error(evt.error);
          }
          if (evt.done && !evt.error && Number(evt.ok ?? 0) > 0) {
            doneOk = true;
          }
        }
      }
      if (hashes.length > 0) onDone?.();
      if (doneOk) {
        const symOf = (a: string) =>
          sortedTokens.find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol ??
          a.slice(0, 6);
        const names = pairs.map((p) => `${symOf(p.tokenA)}/${symOf(p.tokenB)}`);
        const label =
          names.length <= 2
            ? names.join(", ")
            : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
        toast.success(`Deployed ${label}`);
        form.reset();
      }
    } catch (e: any) {
      setSubmitError(e?.shortMessage || e?.message || "Deploy failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && busy) return;
        onOpenChange(o);
      }}
    >
      <DialogContent
        ref={contentRef}
        className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Deploy strategy</DialogTitle>
          <DialogDescription>
            One capital, template picks, we split it. Full-range on Base.
          </DialogDescription>
        </DialogHeader>

        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <fieldset
              disabled={busy}
              className="space-y-5 border-0 m-0 p-0 min-w-0 disabled:opacity-70"
            >
              <CapitalSection
                options={sortedTokens}
                walletMap={balanceMap}
                availableMap={availableMap}
              />
              <TemplateSection tops={tops ?? []} />
              <ManualPairsSection tokens={sortedTokens} />

              <section className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium">
                    {aggressive ? "Aggressive mode" : "Stable mode"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {aggressive
                      ? "AI may rotate these into top strategies at any time."
                      : "Sticks here. No rotation, fees compound in place."}
                  </div>
                </div>
                <Controller
                  name="aggressive"
                  control={form.control}
                  render={({ field }) => (
                    <ToggleGroup
                      type="single"
                      value={field.value ? "aggressive" : "stable"}
                      onValueChange={(val) => {
                        if (val) field.onChange(val === "aggressive");
                      }}
                    >
                      <ToggleGroupItem value="stable" aria-label="Stable mode">
                        Stable
                      </ToggleGroupItem>
                      <ToggleGroupItem
                        value="aggressive"
                        aria-label="Aggressive mode"
                      >
                        Aggressive
                      </ToggleGroupItem>
                    </ToggleGroup>
                  )}
                />
              </section>
            </fieldset>

            <div className="space-y-2 mt-2">
              {submitError && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive wrap-break-words">
                  {submitError}
                </div>
              )}
              {(busy || Object.keys(liveSteps).length > 0) && (
                <div className="space-y-1.5 rounded-lg border border-border/50 p-3">
                  {busy && Object.keys(liveSteps).length === 0 && (
                    <div className="flex items-center gap-2 text-xs min-w-0">
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      <span className="text-muted-foreground">
                        Preparing deploy - loading strategy modules…
                      </span>
                    </div>
                  )}
                  {Object.entries(liveSteps).map(([idx, s]) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 text-xs min-w-0"
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          s.stage === "failed"
                            ? "bg-destructive"
                            : s.stage === "deployed"
                              ? "bg-green-500"
                              : "bg-amber-500 animate-pulse",
                        )}
                      />
                      <span className="font-medium shrink-0">
                        Pair {Number(idx) + 1}
                      </span>
                      <span
                        className="text-muted-foreground truncate min-w-0 flex-1"
                        title={s.detail ? `${s.stage} - ${s.detail}` : s.stage}
                      >
                        {s.stage}
                        {s.detail ? ` - ${s.detail}` : ""}
                      </span>
                      {s.txHash && (
                        <Link
                          href={`https://basescan.org/tx/${s.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto font-mono text-[11px] text-muted-foreground hover:text-foreground shrink-0"
                        >
                          {s.txHash.slice(0, 8)}…
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {txHashes.length > 0 && (
                <div className="space-y-1">
                  {txHashes.map((h) => (
                    <Link
                      key={h}
                      href={`https://basescan.org/tx/${h}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-center font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {h.slice(0, 10)}…{h.slice(-6)}
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <Button
              type="submit"
              className="w-full rounded-full"
              size="lg"
              disabled={busy}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Deploying…" : "Deploy"}
            </Button>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}
