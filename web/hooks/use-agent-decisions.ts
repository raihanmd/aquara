"use client";

import { useQuery } from "@tanstack/react-query";

export interface AgentDecisionRow {
  id: string;
  strategyHash: string;
  pair: string;
  action: string;
  reason: string;
  txHash: string | null;
  createdAt: string;
}

export function useAgentDecisions(maker?: string | null, limit = 10) {
  const query = useQuery({
    queryKey: ["aqua", "agent-decisions", maker, limit] as const,
    queryFn: async (): Promise<AgentDecisionRow[]> => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (maker) params.set("maker", maker);
      const res = await fetch(`/api/agent/decisions?${params.toString()}`);
      if (!res.ok) throw new Error(`Decisions API ${res.status}`);
      const json = await res.json();
      return (Array.isArray(json) ? json : []) as AgentDecisionRow[];
    },
    staleTime: 30_000,
    retry: 1,
    enabled: !!maker,
  });

  return {
    data: (query.data ?? []) as AgentDecisionRow[],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
