"use client";

import { useAccount, useConnect, useDisconnect, useConnectors } from "wagmi";
import { Button } from "@/components/ui/button";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const connectors = useConnectors();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <Button
        onClick={() => disconnect()}
        variant="outline"
        size="sm"
        className="group gap-2 bg-muted/30 text-foreground/80 hover:bg-muted/50 border-border/40 ml-auto"
      >
        <span className="size-1.5 rounded-full bg-emerald-500 group-hover:bg-red-400 transition-colors" />
        <span className="group-hover:hidden">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <span className="hidden group-hover:inline text-muted-foreground">
          Disconnect
        </span>
      </Button>
    );
  }

  return (
    <Button
      onClick={() => {
        const connector = connectors[0];
        if (connector) connect({ connector });
      }}
      disabled={isPending}
      variant="default"
      size="sm"
      className="bg-foreground text-background hover:bg-foreground/90 border-border/40 ml-auto"
    >
      {isPending ? "Connecting..." : "Connect Wallet"}
    </Button>
  );
}
