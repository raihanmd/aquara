"use client";

import {
  AlertCircleIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderIcon,
  ShieldCheckIcon,
  StampIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDelegation } from "@/hooks/use-delegation";
import { cn } from "@/lib/utils";
import Link from "next/link";

interface DelegationStepperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "all" for all positions, or array of specific position tokenIds */
  mode: "all" | string[];
}

type Phase = "review" | "signing" | "done";

const PERMISSIONS = [
  {
    icon: ArrowUpFromLineIcon,
    label: "Ship strategies",
    detail: "ship · 0xf50b870f",
  },
  {
    icon: ArrowDownToLineIcon,
    label: "Dock strategies",
    detail: "dock · 0x28defc17",
  },
  {
    icon: StampIcon,
    label: "Approve tokens",
    detail: "approve · 0x095ea7b3",
  },
];

export function DelegationStepper({
  open,
  onOpenChange,
  mode,
}: DelegationStepperProps) {
  const [phase, setPhase] = useState<Phase>("review");
  const { agentAddress, isSubmitting, error, txHash, delegate, status } =
    useDelegation();

  const handleDelegate = async () => {
    setPhase("signing");
    const positionIds = mode === "all" ? undefined : mode;
    const success = await delegate(positionIds);
    if (success) {
      setPhase("done");
    }
  };

  const handleClose = () => {
    setPhase("review");
    onOpenChange(false);
  };

  const isSpecific = mode !== "all";
  const modeLabel = isSpecific
    ? `${(mode as string[]).length} position${(mode as string[]).length !== 1 ? "s" : ""}`
    : "all positions";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5 text-primary" />
            Agent pass
          </DialogTitle>
          <DialogDescription>
            One signature authorizes the Aqua agent on {modeLabel} for 30 days.
            Revoke anytime from your wallet.
          </DialogDescription>
        </DialogHeader>

        {phase === "review" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl bg-muted/40 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                🤖
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Aqua Agent</div>
                {agentAddress ? (
                  <Link
                    href={`https://basescan.org/address/${agentAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={agentAddress}
                    className="block truncate font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {agentAddress.slice(0, 6)}...
                    {agentAddress.slice(agentAddress.length - 4)}
                  </Link>
                ) : (
                  <div className="text-xs text-muted-foreground">Loading…</div>
                )}
              </div>
              <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Base
              </span>
            </div>

            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                Allowed calls
              </div>
              <ul className="divide-y divide-border/40 rounded-xl border border-border/50">
                {PERMISSIONS.map((p) => (
                  <li
                    key={p.label}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <p.icon className="size-4 shrink-0 text-primary" />
                    <span className="text-sm">{p.label}</span>
                    <code className="ml-auto font-mono text-[11px] text-muted-foreground/70">
                      {p.detail}
                    </code>
                  </li>
                ))}
              </ul>
            </div>

            {status === "delegated" && (
              <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2">
                <CheckCircleIcon className="size-4 shrink-0 text-green-500" />
                <span className="text-xs text-green-600">
                  Pass already active - signing again refreshes it.
                </span>
              </div>
            )}

            <Button
              className="w-full rounded-full"
              size="lg"
              onClick={handleDelegate}
              disabled={!agentAddress || isSubmitting}
            >
              <KeyRoundIcon className="size-4" />
              Authorize agent
            </Button>
          </div>
        )}

        {phase === "signing" && (
          <div className="flex flex-col items-center gap-4 py-8">
            {isSubmitting ? (
              <>
                <LoaderIcon className="size-10 animate-spin text-primary" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium">Confirm in your wallet</p>
                      <p className="text-xs text-muted-foreground">
                        One signature - the agent pass is submitted for you
                      </p>
                </div>
              </>
            ) : error ? (
              <>
                <AlertCircleIcon className="size-10 text-destructive" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-destructive">
                    Authorization failed
                  </p>
                  <p className="max-w-xs break-words text-xs text-muted-foreground">
                    {error}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="rounded-full"
                  onClick={() => setPhase("review")}
                >
                  Back
                </Button>
              </>
            ) : null}
          </div>
        )}

        {phase === "done" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <span
              className={cn(
                "flex size-14 items-center justify-center rounded-full",
                "bg-primary/10 text-primary",
              )}
            >
              <CheckCircleIcon className="size-7" />
            </span>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium">Agent pass active</p>
              <p className="text-xs text-muted-foreground">
                The agent now manages {modeLabel} — every position included, no setup needed.
              </p>
            </div>

            {txHash && (
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                View on Basescan
                <ExternalLinkIcon className="size-3" />
              </a>
            )}

            <Button className="w-full rounded-full" onClick={handleClose}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
