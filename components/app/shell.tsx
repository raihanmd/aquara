"use client";

import { RefreshCwIcon } from "lucide-react";
import { usePositionContext } from "@/hooks/use-position-context";
import { ConnectButton } from "../connect-button";
import { SettingsButton } from "../settings-modal";
import { PositionDashboard } from "../positions/position-dashboard";
import { PositionsGrid } from "../positions/positions-grid";

export function AppShell() {
  const { selectedPosition, refresh, isLoading } = usePositionContext();

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <div className="absolute top-3 right-4 z-20 flex items-center gap-2">
        <SettingsButton />
        <button
          onClick={refresh}
          disabled={isLoading}
          className="rounded-lg border border-border/40 bg-muted/30 p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer disabled:opacity-30"
          title="Refresh positions"
        >
          <RefreshCwIcon
            className={`size-3 ${isLoading ? "animate-spin" : ""}`}
          />
        </button>
        <ConnectButton />
      </div>

      <div className="absolute bottom-3 right-4 z-20 flex items-center gap-3">
        <span className="text-[10px] text-muted-foreground/50">
          Built with ❤️ for Uniswap at ETHGlobal
        </span>
        <a
          href="#"
          className="text-[10px] text-muted-foreground/45 hover:text-muted-foreground transition-colors"
        >
          Documentation
        </a>
        <a
          href="#"
          className="text-[10px] text-muted-foreground/45 hover:text-muted-foreground transition-colors"
        >
          Twitter
        </a>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        {selectedPosition ? (
          <PositionDashboard position={selectedPosition} />
        ) : (
          <PositionsGrid />
        )}
      </div>
    </div>
  );
}
