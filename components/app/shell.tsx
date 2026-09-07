"use client";

import { ConnectButton } from "../connect-button";
import { PositionsGrid } from "../positions/positions-grid";

export function AppShell() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="sticky top-0 z-40 flex items-center justify-between border-b border-border/40 bg-background/70 px-6 py-3 backdrop-blur-[2px]">
          <ConnectButton />
        </div>
        <PositionsGrid />
      </div>
    </div>
  );
}
