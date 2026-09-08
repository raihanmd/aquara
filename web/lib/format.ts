import type { TopPosition } from "@/hooks/use-top-positions";

export function formatUSD(value: number | null | undefined): string {
  if (value == null || value === 0) return "$0.00";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return "$0.00";
}

export function formatUSDCompact(value: number | null | undefined): string {
  if (value == null || value === 0) return "$0.00";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function tickToPrice(tick: number): string {
  const price = Math.pow(1.0001, tick);
  if (price >= 0.01 && price <= 100_000) return `$${price.toFixed(2)}`;
  return price.toPrecision(4);
}

export function tickToPriceNum(tick: number): number {
  return Math.pow(1.0001, tick);
}

export const DURATIONS = [
  { label: "1H", value: "HOUR" },
  { label: "1D", value: "DAY" },
  { label: "1W", value: "WEEK" },
  { label: "1M", value: "MONTH" },
  { label: "1Y", value: "YEAR" },
] as const;

export function formatAPY(apy: number | null | undefined): string {
  if (apy == null) return "0.0%";
  return `${apy.toFixed(1)}%`;
}

export function getPairLabel(pos: TopPosition): string {
  const t0 =
    pos.tokens?.[0]?.symbol ??
    pos.tokens?.[0]?.address?.slice(0, 6) ??
    "TOKEN0";
  const t1 =
    pos.tokens?.[1]?.symbol ??
    pos.tokens?.[1]?.address?.slice(0, 6) ??
    "TOKEN1";
  return `${t0} / ${t1}`;
}

export function getFeeLabel(pos: TopPosition): string {
  const c = pos.classification;
  if (typeof c === "string" && c.includes("%")) return c;
  if (c && typeof c === "object" && "fee" in c) {
    const fee = (c as Record<string, unknown>).fee;
    if (typeof fee === "string") return fee;
    if (typeof fee === "number") return `${(fee / 10000).toFixed(2)}%`;
  }
  return "0.05%";
}

export function getChainLabel(chainId: number): string {
  if (chainId === 4663) return "Robinhood";
  if (chainId === 8453) return "Base";
  if (chainId === 1) return "Ethereum";
  return `Chain ${chainId}`;
}
