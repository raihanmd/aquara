"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  TopPosition,
  UseTopPositionsParams,
} from "@/lib/aqua-api";

export type {
  TopPosition,
  TopPositionToken,
  TopPositionPerformance,
  UseTopPositionsParams,
} from "@/lib/aqua-api";

export function useTopPositions({
  chainIds,
  limit = 10,
  sortBy = "apy",
}: UseTopPositionsParams) {
  const query = useQuery({
    queryKey: ["aqua", "top-positions", chainIds, limit, sortBy] as const,
    queryFn: async (): Promise<TopPosition[]> => {
      const params = new URLSearchParams({
        limit: String(limit),
        sortBy,
      });
      chainIds.forEach((id) => params.append("chainIds", String(id)));
      const res = await fetch(`/api/aqua/top?${params.toString()}`);
      if (!res.ok) throw new Error(`Top API ${res.status}`);
      const json = await res.json();
      return (json.data ?? []) as TopPosition[];
    },
    staleTime: 60_000,
    retry: 1,
    enabled: chainIds.length > 0,
  });

  return {
    data: (query.data ?? []) as TopPosition[],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
