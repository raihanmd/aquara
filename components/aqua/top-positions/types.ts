export const CHAIN_OPTIONS = [
  { label: "Base", value: "Base", chainIds: [8453] },
  { label: "Ethereum", value: "Ethereum", chainIds: [1] },
  { label: "Robinhood", value: "Robinhood", chainIds: [4663] },
] as const;

export type ChainFilter = (typeof CHAIN_OPTIONS)[number]["value"];
export type SortBy = "volume" | "apy";
