"use client";

import { memo, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TokenRow } from "./token-row";
import type { TokenOpt } from "./schema";

const CAP = 30;

export const TokenSelect = memo(function TokenSelect({
  value,
  onChange,
  tokens,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  tokens: TokenOpt[];
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? tokens.filter(
          (t) =>
            t.symbol.toLowerCase().includes(needle) ||
            t.name.toLowerCase().includes(needle) ||
            t.address.toLowerCase().includes(needle),
        )
      : tokens;
    return list.slice(0, CAP);
  }, [tokens, q]);

  return (
    <Select
      value={value}
      onValueChange={onChange}
      onOpenChange={(o) => {
        if (!o) setQ("");
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <div
          className="px-2 pb-1 pt-1"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Input
            placeholder="Search token"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        {filtered.map((t) => (
          <SelectItem key={t.address} value={t.address}>
            <TokenRow token={t} />
          </SelectItem>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No match
          </div>
        )}
      </SelectContent>
    </Select>
  );
});
