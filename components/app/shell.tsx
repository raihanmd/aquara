"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "../connect-button";
import { PositionsGrid } from "../positions/positions-grid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const SLIPPAGE_PRESETS = [0.1, 0.5, 1, 2];

function SlippageControl() {
  const { address } = useAccount();
  const [slippage, setSlippage] = useState<number>(0.5);

  useEffect(() => {
    if (!address) return;
    fetch(`/api/settings?maker=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (typeof j?.slippage === "number") setSlippage(j.slippage);
      })
      .catch(() => {});
  }, [address]);

  const save = async (v: number) => {
    setSlippage(v);
    if (!address) return;
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maker: address, slippage: v }),
    }).catch(() => {});
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full text-xs"
          disabled={!address}
          title="Global slippage for agent swaps"
        >
          Slip {slippage}%
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Agent slippage</DropdownMenuLabel>
        {SLIPPAGE_PRESETS.map((v) => (
          <DropdownMenuItem key={v} onClick={() => save(v)}>
            {v}%{v === slippage ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="sticky top-0 z-40 flex items-center justify-end gap-2 border-b border-border/40 bg-background/70 px-6 py-3 backdrop-blur-[2px]">
          <SlippageControl />
          <ConnectButton />
        </div>
        <PositionsGrid />
      </div>
    </div>
  );
}
