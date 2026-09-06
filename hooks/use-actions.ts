"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/config";

export interface Activity {
  id: string;
  type: string;
  status: string;
  summary: string;
  timestamp: number;
  tokenId?: string;
  owner?: string;
  txHashes?: string[];
}

export function useActions(ownerAddress?: string) {
  const [data, setData] = useState<Activity[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const fetchActions = () => {
      const params = new URLSearchParams({ limit: "20" });
      if (ownerAddress) params.set("address", ownerAddress);
      fetch(`${API_URL}/api/actions?${params}`)
        .then((r) => r.json())
        .then((json: Activity[]) => {
          if (cancelled) return;
          if (!Array.isArray(json)) return;
          const filtered = json.filter((a) => a.type !== "monitor");
          setData(filtered.slice(0, 10));
          setIsLoading(false);
        })
        .catch(() => {
          if (!cancelled) setIsLoading(false);
        });
    };

    setIsLoading(true);
    fetchActions();
    const interval = setInterval(fetchActions, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ownerAddress]);

  return { data, isLoading };
}
