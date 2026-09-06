"use client";

import { useAccount, useConnect, useDisconnect, useConnectors } from "wagmi";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const connectors = useConnectors();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="group flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/50 cursor-pointer"
      >
        <span className="size-1.5 rounded-full bg-emerald-500 group-hover:bg-red-400 transition-colors" />
        <span className="group-hover:hidden">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <span className="hidden group-hover:inline text-muted-foreground">
          Disconnect
        </span>
      </button>
    );
  }

  return (
    <button
      onClick={() => {
        const connector = connectors[0];
        if (connector) connect({ connector });
      }}
      disabled={isPending}
      className="rounded-lg border border-border/40 bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 cursor-pointer disabled:opacity-50"
    >
      {isPending ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
