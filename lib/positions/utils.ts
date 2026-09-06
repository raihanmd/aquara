import { encodeAbiParameters, keccak256 } from "viem";
import type { PoolKey } from "./types";
import { TOKEN_SYMBOLS } from "./constants";

export function decodePositionInfo(packed: bigint): {
  tickLower: number;
  tickUpper: number;
} {
  const toSigned24 = (raw: number) =>
    raw >= 0x800000 ? raw - 0x1000000 : raw;
  return {
    tickLower: toSigned24(Number((packed >> 8n) & 0xffffffn)),
    tickUpper: toSigned24(Number((packed >> 32n) & 0xffffffn)),
  };
}

export function computePoolId(poolKey: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [poolKey]
    )
  );
}

export function getTokenSymbol(address: string): string {
  return TOKEN_SYMBOLS[address.toLowerCase()] ?? `${address.slice(0, 6)}...`;
}

export function formatLiquidity(liquidity: bigint): string {
  const num = Number(liquidity);
  if (num >= 1e18) return `${(num / 1e18).toFixed(2)}E`;
  if (num >= 1e15) return `${(num / 1e15).toFixed(2)}P`;
  if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toString();
}

export function calculateRangeStatus(
  tickLower: number,
  tickUpper: number,
  currentTick: number
): { isInRange: boolean; percentOutOfRange: number } {
  const isInRange = currentTick >= tickLower && currentTick <= tickUpper;
  if (isInRange) return { isInRange: true, percentOutOfRange: 0 };

  const rangeWidth = tickUpper - tickLower;
  const ticksOut =
    currentTick < tickLower
      ? tickLower - currentTick
      : currentTick - tickUpper;
  const percentOutOfRange = rangeWidth > 0 ? (ticksOut / rangeWidth) * 100 : 0;

  return { isInRange: false, percentOutOfRange: Math.round(percentOutOfRange) };
}

export function serializePosition(position: {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  pool: { currentTick: number; sqrtPriceX96: bigint; totalLiquidity: bigint };
  poolKey: PoolKey;
  isInRange: boolean;
  percentOutOfRange: number;
  token0Symbol: string;
  token1Symbol: string;
  metrics?: {
    amount0: string;
    amount1: string;
    positionSizeUSD: number;
    feesEarnedUSD: number;
    feePercent: string;
    currentPrice: string;
    minPrice: string;
    maxPrice: string;
    apyEstimate: number | null;
  };
}) {
  const m = position.metrics;
  return {
    tokenId: position.tokenId,
    token0: position.token0Symbol,
    token1: position.token1Symbol,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    currentTick: position.pool.currentTick,
    liquidity: position.liquidity.toString(),
    isInRange: position.isInRange,
    percentOutOfRange: position.percentOutOfRange,
    fee: position.poolKey.fee,
    tickSpacing: position.poolKey.tickSpacing,
    ...(m && {
      positionSizeUSD: m.positionSizeUSD,
      feesEarnedUSD: m.feesEarnedUSD,
      feePercent: m.feePercent,
      currentPrice: m.currentPrice,
      minPrice: m.minPrice,
      maxPrice: m.maxPrice,
      amount0: m.amount0,
      amount1: m.amount1,
      apyEstimate: m.apyEstimate,
    }),
  };
}
