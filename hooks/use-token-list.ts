"use client";

import { useQuery } from "@tanstack/react-query";

export interface TokenListItem {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export function useTokenList(chainId = 8453, enabled = true) {
  const query = useQuery({
    queryKey: ["aqua", "tokens", chainId] as const,
    queryFn: async (): Promise<TokenListItem[]> => {
      const res = await fetch(`/api/aqua/tokens?chainIds=${chainId}`);
      if (!res.ok) throw new Error(`Tokens API ${res.status}`);
      const json = await res.json();
      const items = (json.items ?? []) as TokenListItem[];
      return items.map((t) => ({ ...t, address: t.address.toLowerCase() }));
    },
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
    enabled,
  });

  return {
    data: (query.data ?? []) as TokenListItem[],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
