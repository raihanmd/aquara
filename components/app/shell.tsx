"use client";

import { ConnectButton } from "../connect-button";
import { SettingsButton } from "../settings-modal";
import { PositionsGrid } from "../positions/positions-grid";

export function AppShell() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <div className="absolute top-3 right-4 z-20 flex items-center gap-2">
        <SettingsButton />
        <ConnectButton />
      </div>

      <div className="absolute bottom-3 right-4 z-20 flex items-center gap-3">
        <span className="text-[10px] text-muted-foreground/50">
          Built with ❤️ for ETHGlobal
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
        <PositionsGrid />
      </div>
    </div>
  );
}
