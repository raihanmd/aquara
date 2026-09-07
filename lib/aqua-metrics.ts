import type { EnrichedAquaPosition } from "@/hooks/use-my-aqua-positions";

export interface TokenShare {
  symbol: string;
  walletUsd: number;
  quotedUsd: number;
  coverage: number | null;
  underfunded: boolean;
}

export interface ShareMetrics {
  totalWalletUsd: number;
  totalQuotedUsd: number;
  slr: number | null;
  tokens: TokenShare[];
  activeCount: number;
  idleCount: number;
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function tokenUsd(t: EnrichedAquaPosition["tokens"][number]): number {
  const bal = (t as any)?.currentBalance;
  if (bal && typeof bal === "object") return num(bal.usd);
  return 0;
}

function walletUsd(t: EnrichedAquaPosition["tokens"][number]): number {
  const w = (t as any)?.walletBalance;
  const bal = w && typeof w === "object" ? w : null;
  if (bal && typeof (bal as any).usd === "number") return num((bal as any).usd);
  return 0;
}

export function computeShareMetrics(
  positions: EnrichedAquaPosition[]
): ShareMetrics {
  const byToken = new Map<string, { walletUsd: number; quotedUsd: number }>();
  let activeCount = 0;
  let idleCount = 0;

  for (const p of positions) {
    if (p.isOutOfRange) idleCount += 1;
    else activeCount += 1;
    for (const t of p.tokens ?? []) {
      const sym = t.symbol ?? t.address.slice(0, 6);
      const slot = byToken.get(sym) ?? { walletUsd: 0, quotedUsd: 0 };
      const w = walletUsd(t);
      if (w > slot.walletUsd) slot.walletUsd = w;
      slot.quotedUsd += tokenUsd(t);
      byToken.set(sym, slot);
    }
  }

  const tokens: TokenShare[] = Array.from(byToken.entries()).map(
    ([symbol, v]) => ({
      symbol,
      walletUsd: v.walletUsd,
      quotedUsd: v.quotedUsd,
      coverage: v.quotedUsd > 0 ? v.walletUsd / v.quotedUsd : null,
      underfunded: v.quotedUsd > 0 && v.walletUsd < v.quotedUsd,
    })
  );
  tokens.sort((a, b) => b.quotedUsd - a.quotedUsd);

  const totalWalletUsd = tokens.reduce((s, t) => s + t.walletUsd, 0);
  const totalQuotedUsd = tokens.reduce((s, t) => s + t.quotedUsd, 0);

  return {
    totalWalletUsd,
    totalQuotedUsd,
    slr: totalWalletUsd > 0 ? totalQuotedUsd / totalWalletUsd : null,
    tokens,
    activeCount,
    idleCount,
  };
}
