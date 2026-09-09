"use client";

import { useConnection } from "wagmi";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
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
import { useMutateSetting, useSetting } from "@/hooks/use-setting";

const SLIPPAGE_PRESETS = [0.1, 0.5, 1, 2];

function SlippageControl() {
  const { address } = useConnection();
  const { data } = useSetting(address);
  const { mutateAsync } = useMutateSetting(address!);

  const save = async (v: number) => {
    if (!address) return;

    await mutateAsync({
      maker: address,
      slippage: v,
    });
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
          Slip {data?.slippage}%
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Agent slippage</DropdownMenuLabel>
        {SLIPPAGE_PRESETS.map((v) => (
          <DropdownMenuItem key={v} onClick={() => save(v)}>
            {v}%{v === data?.slippage ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const queryClient = useQueryClient();
  const fetching = useIsFetching();
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="sticky top-0 z-40 flex items-center justify-end gap-2 border-b border-border/40 bg-background/70 px-6 py-3 backdrop-blur-[2px]">
          <SlippageControl />
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs"
            onClick={() => queryClient.invalidateQueries()}
            title="Refresh all data"
            aria-label="Refresh all data"
          >
            <RefreshCwIcon
              className={fetching > 0 ? "size-3.5 animate-spin" : "size-3.5"}
            />
          </Button>
          <ConnectButton />
        </div>
        <PositionsGrid />
      </div>
    </div>
  );
}
