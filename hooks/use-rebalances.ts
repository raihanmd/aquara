"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/config";

export interface RebalanceRecord {
  id: string;
  tokenId: string;
  owner: string;
  timestamp: number;
  success: boolean;
  txHash?: string;
  newRange?: { tickLower: number; tickUpper: number };
  error?: string;
}

export function useRebalances(ownerAddress?: string) {
  const [data, setData] = useState<RebalanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchRebalances = () => {
      const params = new URLSearchParams({ limit: "20" });
      if (ownerAddress) params.set("address", ownerAddress);
      fetch(`${API_URL}/api/rebalances?${params}`)
        .then((r) => r.json())
        .then((json: RebalanceRecord[]) => {
          if (cancelled) return;
          if (Array.isArray(json)) {
            setData(json);
            setIsLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setIsLoading(false);
        });
    };

    setIsLoading(true);
    fetchRebalances();
    const interval = setInterval(fetchRebalances, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ownerAddress]);

  return { data, isLoading };
}
