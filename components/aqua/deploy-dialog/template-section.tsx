"use client";

import { memo } from "react";
import { useWatch, useFormContext } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { StrategyCard } from "@/components/aqua/strategy-card";
import { cn } from "@/lib/utils";
import type { TopPosition } from "@/hooks/use-top-positions";
import type { FormValues } from "./schema";

function topTokenUsd(t: TopPosition["tokens"][number]): number {
  const w: any = (t as any)?.wallet?.balance;
  if (w && typeof w.usd === "number" && w.usd > 0) return w.usd;
  const bal: any = (t as any)?.currentBalance;
  if (bal && typeof bal === "object" && typeof bal.usd === "number")
    return bal.usd ?? 0;
  return 0;
}
export const TemplateSection = memo(function TemplateSection({
  tops,
}: {
  tops: TopPosition[];
}) {
  const { control, setValue, getValues } = useFormContext<FormValues>();
  const picked = useWatch({ control, name: "templates" }) ?? [];

  const toggle = (hash: string) => {
    const cur: string[] = getValues("templates") ?? [];
    setValue(
      "templates",
      cur.includes(hash) ? cur.filter((h) => h !== hash) : [...cur, hash],
      { shouldValidate: true },
    );
  };

  if (tops.length === 0) return null;

  return (
    <section className="space-y-2">
      <span className="text-sm font-medium mb-2 block">Top Positions</span>
      <div className="grid gap-3 sm:grid-cols-2">
        {tops.slice(0, 4).map((p) => {
          const u0 = topTokenUsd(p.tokens?.[0]);
          const u1 = topTokenUsd(p.tokens?.[1]);
          const active = picked.includes(p.strategyHash);
          return (
            <Button
              key={p.strategyHash}
              type="button"
              variant="ghost"
              onClick={() => toggle(p.strategyHash)}
              aria-pressed={active}
              aria-label={`${p.tokens?.[0]?.symbol} ${p.tokens?.[1]?.symbol}`}
              className={cn(
                "h-auto w-full rounded-xl p-0 text-left font-normal px-0",
                active &&
                  "ring-2 ring-primary ring-offset-2 ring-offset-background",
              )}
            >
              <StrategyCard
                pair={`${p.tokens?.[0]?.symbol ?? "?"} / ${p.tokens?.[1]?.symbol ?? "?"}`}
                tokens={[
                  {
                    symbol: p.tokens?.[0]?.symbol,
                    logoURI: p.tokens?.[0]?.logoURI,
                    address: p.tokens?.[0]?.address ?? "",
                    usd: u0,
                  },
                  {
                    symbol: p.tokens?.[1]?.symbol,
                    logoURI: p.tokens?.[1]?.logoURI,
                    address: p.tokens?.[1]?.address ?? "",
                    usd: u1,
                  },
                ]}
                fee={null}
                apy={
                  p.performance?.fees?.last24h?.apy ??
                  p.performance?.fees?.last7d?.apy ??
                  null
                }
                volume={
                  p.performance?.volume?.last24h?.usd ??
                  p.performance?.volume?.last7d?.usd ??
                  null
                }
                sizeUsd={u0 + u1 > 0 ? u0 + u1 : null}
                showBreakdown={false}
              />
            </Button>
          );
        })}
      </div>
    </section>
  );
});
