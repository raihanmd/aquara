"use client";

import { memo } from "react";
import { Controller, useWatch, useFormContext } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TokenSelect } from "./token-select";
import type { TokenOpt, FormValues } from "./schema";

function formatUnits(raw: string, decimals: number): string {
  try {
    const v = Number(raw) / 10 ** decimals;
    if (!isFinite(v)) return "0";
    return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
  } catch {
    return "0";
  }
}

export const CapitalSection = memo(function CapitalSection({
  options,
  walletMap,
}: {
  options: TokenOpt[];
  walletMap: Map<string, string>;
}) {
  const { control, setValue } = useFormContext<FormValues>();
  const capital = useWatch({ control, name: "capital" });

  const capitalToken = options.find(
    (t) => t.address.toLowerCase() === (capital ?? "").toLowerCase(),
  );
  const walletRaw = walletMap.get((capital ?? "").toLowerCase());

  const setPct = (pct: number) => {
    if (!walletRaw || !capitalToken) return;
    const human = (Number(walletRaw) / 10 ** capitalToken.decimals) * pct;
    setValue(
      "capitalAmount",
      human > 0 ? String(Number(human.toFixed(6))) : "0",
      { shouldValidate: true },
    );
  };

  return (
    <section className="space-y-2">
      <span className="text-sm font-medium mb-2 block">Capital</span>
      <Controller
        name="capital"
        control={control}
        render={({ field }) => (
          <TokenSelect
            value={field.value}
            onChange={field.onChange}
            tokens={options}
            placeholder="Pick capital token"
          />
        )}
      />
      <div className="text-[11px] text-muted-foreground">
        Balance:{" "}
        {walletRaw && capitalToken
          ? formatUnits(walletRaw, capitalToken.decimals)
          : "-"}
      </div>
      <div className="flex gap-1.5">
        {[25, 50, 75].map((p) => (
          <Button
            key={p}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 flex-1 rounded-full text-xs"
            disabled={!walletRaw}
            onClick={() => setPct(p / 100)}
          >
            {p}%
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 flex-1 rounded-full text-xs"
          disabled={!walletRaw}
          onClick={() => setPct(1)}
        >
          MAX
        </Button>
      </div>
      <Controller
        name="capitalAmount"
        control={control}
        render={({ field, fieldState }) => (
          <>
            <Input
              {...field}
              inputMode="decimal"
              placeholder="Capital amount"
            />
            {fieldState.error && (
              <p className="text-xs text-destructive">
                {fieldState.error.message}
              </p>
            )}
          </>
        )}
      />
    </section>
  );
});
