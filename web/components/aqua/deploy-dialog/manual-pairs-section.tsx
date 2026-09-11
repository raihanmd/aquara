"use client";

import { memo, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { TokenSelect } from "./token-select";
import type { TokenOpt, FormValues } from "./schema";
import { USDC_BASE, WETH_BASE } from "./schema";

export const ManualPairsSection = memo(function ManualPairsSection({
  tokens,
}: {
  tokens: TokenOpt[];
}) {
  const { control, setValue } = useFormContext<FormValues>();
  const pairs = useWatch({ control, name: "manualPairs" }) ?? [];
  const [a, setA] = useState(USDC_BASE);
  const [b, setB] = useState(WETH_BASE);

  const add = () => {
    if (a.toLowerCase() === b.toLowerCase()) return;
    const key = [a.toLowerCase(), b.toLowerCase()].sort().join("|");
    const dup = pairs.some(
      (p) =>
        [p.tokenA.toLowerCase(), p.tokenB.toLowerCase()].sort().join("|") ===
        key,
    );
    if (dup) return;
    setValue("manualPairs", [...pairs, { tokenA: a, tokenB: b }], {
      shouldValidate: true,
    });
  };

  const removeAt = (i: number) => {
    setValue(
      "manualPairs",
      pairs.filter((_, idx) => idx !== i),
      { shouldValidate: true },
    );
  };

  return (
    <section className="space-y-2">
      <span className="text-sm font-medium mb-2 block">Manual pairs</span>
      {pairs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pairs.map((p, i) => {
            const s0 =
              tokens.find(
                (t) => t.address.toLowerCase() === p.tokenA.toLowerCase(),
              )?.symbol ?? p.tokenA.slice(0, 6);
            const s1 =
              tokens.find(
                (t) => t.address.toLowerCase() === p.tokenB.toLowerCase(),
              )?.symbol ?? p.tokenB.slice(0, 6);
            return (
              <Button
                key={`${p.tokenA}-${p.tokenB}-${i}`}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeAt(i)}
                title="Remove pair"
                className="h-auto rounded-full border border-border/50 bg-muted/30 px-2.5 py-1 text-xs font-normal hover:border-destructive/50 hover:text-destructive"
              >
                {s0} / {s1} ✕
              </Button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <TokenSelect value={a} onChange={setA} tokens={tokens} placeholder="Token A" />
        <TokenSelect value={b} onChange={setB} tokens={tokens} placeholder="Token B" />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 rounded-full text-xs"
        onClick={add}
      >
        + Add pair
      </Button>
    </section>
  );
});
