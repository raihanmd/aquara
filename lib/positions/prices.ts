/**
 * Token price fetching via CoinGecko API.
 * Caches results for 1 minute to avoid rate limiting.
 */

const COINGECKO_IDS: Record<string, string> = {
  ETH: "ethereum",
  WETH: "ethereum",
  USDC: "usd-coin",
  USDS: "dai", // USDS is ~$1 stable
  cbBTC: "bitcoin",
};

const cache: { prices: Record<string, number>; ts: number } = {
  prices: {},
  ts: 0,
};

const CACHE_TTL = 60_000; // 1 min

export async function getTokenPrices(
  symbols: string[]
): Promise<Record<string, number>> {
  if (Date.now() - cache.ts < CACHE_TTL && symbols.every((s) => s in cache.prices)) {
    return cache.prices;
  }

  const ids = [...new Set(symbols.map((s) => COINGECKO_IDS[s]).filter(Boolean))];
  if (ids.length === 0) return {};

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
      { next: { revalidate: 60 } }
    );

    if (!res.ok) {
      console.warn(`[prices] CoinGecko returned ${res.status}`);
      return cache.prices;
    }

    const data = await res.json();

    const prices: Record<string, number> = {};
    for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
      if (data[geckoId]?.usd) {
        prices[symbol] = data[geckoId].usd;
      }
    }

    cache.prices = prices;
    cache.ts = Date.now();
    return prices;
  } catch (e) {
    console.warn("[prices] Failed to fetch:", e);
    return cache.prices;
  }
}
