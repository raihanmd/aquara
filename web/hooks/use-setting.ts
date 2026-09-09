"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface SettingResponse {
  slippage: number;
}

export interface MutateSettingPayload {
  maker: string;
  slippage: number;
}

export function useSetting(maker?: string) {
  const query = useQuery({
    queryKey: ["aqua", "setting", maker] as const,
    queryFn: async (): Promise<SettingResponse> => {
      const params = new URLSearchParams({ maker: String(maker) });
      const res = await fetch(`/api/settings?${params.toString()}`);
      if (!res.ok) throw new Error(`Setting API ${res.status}`);
      const json = await res.json();
      return json as SettingResponse;
    },
    staleTime: 30_000,
    retry: 1,
    enabled: !!maker,
  });

  return {
    data: query.data as SettingResponse,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

export function useMutateSetting(maker: string) {
  const query = useQueryClient();
  return useMutation({
    mutationFn: async (data: MutateSettingPayload) => {
      return await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maker: data.maker, slippage: data.slippage }),
      });
    },
    onSuccess: () => {
      query.invalidateQueries({ queryKey: ["aqua", "setting", maker] });
    },
  });
}
