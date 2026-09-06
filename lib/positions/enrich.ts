import { type PublicClient, parseAbi } from "viem";
import type { EnrichedPosition } from "./types";
import { POSITION_MANAGER, STATE_VIEW } from "./constants";
import { getTokenPrices } from "./prices";

const Q128 = 2n ** 128n;
const UINT256 = 2n ** 256n;

// Extended StateView ABI for fee queries
const FEE_ABI = parseAbi([
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) external view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) external view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
]);

function getTokenDecimals(symbol: string): number {
  const decimals: Record<string, number> = {
    ETH: 18, WETH: 18, USDC: 6, USDS: 18, cbBTC: 8, VIRTUAL: 18, wstETH: 18,
  };
  return decimals[symbol] ?? 18;
}

import type { PositionMetrics } from "./types";
export type { PositionMetrics };

/**
 * Lightweight tick -> price conversion without Uniswap SDK.
 * price = 1.0001 ^ tick
 */
function tickToPriceNum(tick: number): number {
  return Math.pow(1.0001, tick);
}

export async function enrichPosition(
  position: EnrichedPosition,
  publicClient: PublicClient
): Promise<PositionMetrics> {
  const { poolKey, tickLower, tickUpper, liquidity, pool, token0Symbol, token1Symbol } = position;

  // 1. Derive amounts from liquidity + price math (simplified, no SDK)
  // For stub: estimate amounts proportionally from liquidity and tick range
  // This is approximate but avoids heavy SDK deps; real amounts come from on-chain later
  const dec0 = getTokenDecimals(token0Symbol);
  const dec1 = getTokenDecimals(token1Symbol);

  // Use sqrtPriceX96 to derive price, then estimate amounts
  // Simplified: split liquidity evenly as placeholder; fee/price logic below is primary value
  const sqrtPrice = Number(pool.sqrtPriceX96) / 2 ** 96;
  const price = sqrtPrice * sqrtPrice;

  // Approximate amounts: use liquidity as raw, scale by decimals
  // This keeps positionSizeUSD meaningful via price derivation below
  const amount0Raw = liquidity > 0n ? (liquidity / 2n).toString() : "0";
  const amount1Raw = liquidity > 0n ? (liquidity / 2n).toString() : "0";
  const amount0 = formatUnits(amount0Raw, dec0);
  const amount1 = formatUnits(amount1Raw, dec1);

  // 2. Get USD prices
  const STABLECOINS = ["USDC", "USDS", "USDT", "DAI"];
  let price0 = 0;
  let price1 = 0;

  if (STABLECOINS.includes(token1Symbol)) {
    price1 = 1;
    price0 = price > 0 ? price : 0;
    // Clamp to reasonable USD range; if price is extreme, fallback to CoinGecko
    if (price0 < 0.000001 || price0 > 1_000_000) {
      const prices = await getTokenPrices([token0Symbol]);
      price0 = prices[token0Symbol] ?? 0;
    }
  } else if (STABLECOINS.includes(token0Symbol)) {
    price0 = 1;
    price1 = price > 0 ? 1 / price : 0;
    if (price1 < 0.000001 || price1 > 1_000_000) {
      const prices = await getTokenPrices([token1Symbol]);
      price1 = prices[token1Symbol] ?? 0;
    }
  } else {
    const prices = await getTokenPrices([token0Symbol, token1Symbol]);
    price0 = prices[token0Symbol] ?? 0;
    price1 = prices[token1Symbol] ?? 0;
    if (price0 > 0 && price1 === 0 && price > 0) {
      price1 = price0 / price;
    } else if (price1 > 0 && price0 === 0 && price > 0) {
      price0 = price1 * price;
    }
  }

  const positionSizeUSD = parseFloat(amount0) * price0 + parseFloat(amount1) * price1;

  // 3. Compute current price and range prices via tick math
  const currentPrice = tickToPriceNum(pool.currentTick).toPrecision(8);
  const minPrice = tickToPriceNum(tickLower).toPrecision(8);
  const maxPrice = tickToPriceNum(tickUpper).toPrecision(8);

  // 4. Fetch unclaimed fees
  let fee0Raw = 0n;
  let fee1Raw = 0n;

  try {
    const tokenIdSalt = `0x${BigInt(position.tokenId).toString(16).padStart(64, "0")}` as `0x${string}`;

    const [posInfoResult, feeGrowthResult] = await publicClient.multicall({
      contracts: [
        {
          address: STATE_VIEW,
          abi: FEE_ABI,
          functionName: "getPositionInfo",
          args: [pool.poolId, POSITION_MANAGER, tickLower, tickUpper, tokenIdSalt],
        },
        {
          address: STATE_VIEW,
          abi: FEE_ABI,
          functionName: "getFeeGrowthInside",
          args: [pool.poolId, tickLower, tickUpper],
        },
      ],
      allowFailure: true,
    });

    if (posInfoResult.status === "success" && feeGrowthResult.status === "success") {
      const [posLiq, fgInside0Last, fgInside1Last] = posInfoResult.result as [bigint, bigint, bigint];
      const [fgInside0Current, fgInside1Current] = feeGrowthResult.result as [bigint, bigint];

      const delta0 = (fgInside0Current - fgInside0Last + UINT256) % UINT256;
      const delta1 = (fgInside1Current - fgInside1Last + UINT256) % UINT256;

      fee0Raw = (delta0 * posLiq) / Q128;
      fee1Raw = (delta1 * posLiq) / Q128;
    }
  } catch {
    // Fee calculation may fail for some positions
  }

  const fee0 = formatUnits(fee0Raw.toString(), dec0);
  const fee1 = formatUnits(fee1Raw.toString(), dec1);
  const feesEarnedUSD = parseFloat(fee0) * price0 + parseFloat(fee1) * price1;

  // 5. Fee percentage
  const feePercent = poolKey.fee >= 1_000_000
    ? "Dynamic"
    : `${(poolKey.fee / 10_000).toFixed(2)}%`;

  // 6. APY estimate
  let apyEstimate: number | null = null;
  if (positionSizeUSD > 0 && feesEarnedUSD > 0) {
    const dailyReturn = feesEarnedUSD / 30;
    apyEstimate = (dailyReturn * 365 / positionSizeUSD) * 100;
  } else if (positionSizeUSD > 0) {
    const feeRate = poolKey.fee / 1_000_000;
    const rangeWidth = tickUpper - tickLower;
    const fullRange = 887272 * 2;
    const concentration = fullRange / Math.max(rangeWidth, 1);
    const dailyVolumeRatio = 0.5;
    const dailyFeeRate = feeRate * dailyVolumeRatio * Math.min(concentration, 100);
    apyEstimate = dailyFeeRate * 365 * 100;
    apyEstimate = Math.min(apyEstimate, 500);
  }

  return {
    amount0,
    amount1,
    amount0Raw,
    amount1Raw,
    positionSizeUSD,
    fee0Raw,
    fee1Raw,
    fee0,
    fee1,
    feesEarnedUSD,
    poolTvlUSD: null,
    feePercent,
    token0PriceUSD: price0,
    token1PriceUSD: price1,
    currentPrice,
    minPrice,
    maxPrice,
    apyEstimate,
  };
}

function formatUnits(value: string, decimals: number): string {
  const padded = value.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals) || "0";
  const fracPart = padded.slice(padded.length - decimals);
  const trimmed = fracPart.replace(/0+$/, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}
