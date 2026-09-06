"use client";

import { useState } from "react";
import { ShieldCheckIcon, LoaderIcon, CheckCircleIcon, AlertCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMmDelegation } from "@/hooks/use-mm-delegation";
import { useAccount } from "wagmi";

export function MmDelegationButton() {
  const { isConnected } = useAccount();
  const { status, agentAddress, isSubmitting, error, ensure7702, grantDelegation, revoke } =
    useMmDelegation();
  const [localSuccess, setLocalSuccess] = useState(false);

  if (!isConnected) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
        <ShieldCheckIcon className="size-4" />
        Connect wallet to delegate
      </div>
    );
  }

  if (status === "checking" || status === "unknown") {
    return (
      <Button disabled variant="outline" className="rounded-full bg-muted">
        <LoaderIcon className="size-4 animate-spin" />
        Checking delegation...
      </Button>
    );
  }

  if (status === "delegated") {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-full border border-green-500/20 bg-green-500/10 px-4 py-2 text-sm text-green-600 dark:text-green-400">
          <CheckCircleIcon className="size-4" />
          MetaMask delegation active
          {agentAddress && (
            <span className="font-mono text-xs opacity-70">
              → {agentAddress.slice(0, 6)}...{agentAddress.slice(-4)}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full text-muted-foreground"
          onClick={async () => {
            setLocalSuccess(false);
            await revoke();
          }}
          disabled={isSubmitting}
        >
          {isSubmitting ? <LoaderIcon className="size-4 animate-spin" /> : null}
          Revoke delegation
        </Button>
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircleIcon className="size-3.5 shrink-0" />
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border/50 bg-card p-4 space-y-2">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <ShieldCheckIcon className="size-4 text-primary" />
          MetaMask Smart Account (7702)
        </h4>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Delegate via EIP-7702 Stateless7702. Agent can only call Aqua ship{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">0xf50b870f</code> / dock{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">0x28defc17</code> +{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">approve</code>. Expiry 30 days. Gas paid by you.
        </p>
        {agentAddress && (
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground">Agent</span>
            <code className="text-xs font-mono text-foreground/70">
              {agentAddress.slice(0, 6)}...{agentAddress.slice(-4)}
            </code>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Button
          className="w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={async () => {
            const ok7702 = await ensure7702();
            if (!ok7702) return;
            const ok = await grantDelegation();
            if (ok) setLocalSuccess(true);
          }}
          disabled={!agentAddress || isSubmitting}
        >
          {isSubmitting ? (
            <>
              <LoaderIcon className="size-4 animate-spin" />
              Delegating...
            </>
          ) : (
            <>
              <ShieldCheckIcon className="size-4" />
              Delegate with MetaMask
            </>
          )}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="rounded-full text-muted-foreground"
          onClick={async () => {
            const ok = await grantDelegation();
            if (ok) setLocalSuccess(true);
          }}
          disabled={!agentAddress || isSubmitting}
        >
          Quick delegate (auto 7702)
        </Button>
      </div>

      {localSuccess && (
        <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs text-green-600 dark:text-green-400">
          <CheckCircleIcon className="size-3.5" />
          Delegation granted and saved to /api/delegations
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          {error}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground text-center">
        Wrong chain auto-switches to Base 0x2105.
      </p>
    </div>
  );
}
