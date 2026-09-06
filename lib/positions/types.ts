import type { Address } from "viem";

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface PoolState {
  poolId: `0x${string}`;
  sqrtPriceX96: bigint;
  currentTick: number;
  totalLiquidity: bigint;
}

export interface PositionMetrics {
  amount0: string;
  amount1: string;
  amount0Raw: string;
  amount1Raw: string;
  positionSizeUSD: number;
  fee0Raw: bigint;
  fee1Raw: bigint;
  fee0: string;
  fee1: string;
  feesEarnedUSD: number;
  poolTvlUSD: number | null;
  feePercent: string;
  token0PriceUSD: number;
  token1PriceUSD: number;
  currentPrice: string;
  minPrice: string;
  maxPrice: string;
  apyEstimate: number | null;
}

export interface EnrichedPosition {
  tokenId: string;
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  pool: PoolState;
  isInRange: boolean;
  percentOutOfRange: number;
  token0Symbol: string;
  token1Symbol: string;
  metrics?: PositionMetrics;
}
