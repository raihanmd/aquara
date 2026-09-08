"use client";

import { memo } from "react";
import { TokenIcon } from "@/components/aqua/top-positions/token-icon";
import type { TokenOpt } from "./schema";

export const TokenRow = memo(function TokenRow({ token }: { token: TokenOpt }) {
  return (
    <span className="flex items-center gap-2">
      <TokenIcon token={token as never} size={20} />
      <span>{token.symbol}</span>
    </span>
  );
});
