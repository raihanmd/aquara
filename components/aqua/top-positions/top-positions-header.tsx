"use client";

import { Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CHAIN_OPTIONS, type ChainFilter, type SortBy } from "./types";

type TopPositionsHeaderProps = {
  count: number;
  isLoading: boolean;
  sortBy: SortBy;
  onSortChange: (v: SortBy) => void;
  chainFilter: ChainFilter;
  onChainFilterChange: (v: ChainFilter) => void;
};

export function TopPositionsHeader({
  count,
  isLoading,
  sortBy,
  onSortChange,
  chainFilter,
  onChainFilterChange,
}: TopPositionsHeaderProps) {
  const chainColors: Record<string, string> = {
    Base: "text-[#0052FF]",
    Ethereum: "text-[#627EEA]",
    Robinhood: "text-[#00A86B]",
    all: "text-primary",
  };
  const chainLabel = CHAIN_OPTIONS.find((c) => c.value === chainFilter)?.label ?? chainFilter;
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Trophy className="size-3.5" aria-hidden="true" />
        </div>
        <h2
          id="top-strategies-heading"
          className="text-sm font-semibold tracking-tight"
        >
          Top Strategies Around The World on:{" "}
          <span className={chainColors[chainFilter] ?? "text-primary"}>{chainLabel}</span>
        </h2>
        <Badge
          variant="muted"
          className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground border-transparent"
        >
          {isLoading ? "…" : count}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ButtonGroup className="rounded-lg border border-border/50 bg-muted/30 p-1 gap-1">
          <Button
            variant={sortBy === "volume" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onSortChange("volume")}
            aria-pressed={sortBy === "volume"}
            className={cn(
              "h-7 rounded-md px-3 py-1.5 text-xs font-medium",
              sortBy === "volume" &&
                "shadow-sm border border-border/50 bg-card",
            )}
          >
            Volume
          </Button>
          <Button
            variant={sortBy === "apy" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onSortChange("apy")}
            aria-pressed={sortBy === "apy"}
            className={cn(
              "h-7 rounded-md px-3 py-1.5 text-xs font-medium",
              sortBy === "apy" && "shadow-sm border border-border/50 bg-card",
            )}
          >
            APY
          </Button>
        </ButtonGroup>

        <div className="flex items-center gap-1.5">
          <label
            htmlFor="chain-filter"
            className="text-xs text-muted-foreground sr-only"
          >
            Filter by chain
          </label>
          <Select
            value={chainFilter}
            onValueChange={(v) => onChainFilterChange(v as ChainFilter)}
          >
            <SelectTrigger
              id="chain-filter"
              size="sm"
              className="w-32 rounded-md border border-border/50 bg-card px-2.5 py-1.5 text-xs font-medium"
              aria-label="Filter by chain"
            >
              <SelectValue placeholder="Select chain" />
            </SelectTrigger>
            <SelectContent>
              {CHAIN_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
