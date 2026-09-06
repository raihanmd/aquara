const UNISWAP_GRAPHQL_GATEWAY = "https://interface.gateway.uniswap.org/v1/graphql";

const UNISWAP_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://app.uniswap.org",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

interface PricePoint {
  timestamp: number;
  token0Price: number;
  token1Price: number;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const poolId = searchParams.get("poolId");
  const duration = searchParams.get("duration") ?? "WEEK";

  if (!poolId) {
    return Response.json({ error: "poolId required" }, { status: 400 });
  }

  const query = `query GetPoolPriceHistory($poolId: String!, $duration: HistoryDuration!) {
    v4Pool(chain: BASE, poolId: $poolId) {
      id
      priceHistory(duration: $duration) {
        timestamp
        token0Price
        token1Price
      }
    }
  }`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(UNISWAP_GRAPHQL_GATEWAY, {
      method: "POST",
      headers: UNISWAP_HEADERS,
      body: JSON.stringify({ query, variables: { poolId, duration } }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return Response.json(
        { error: `Uniswap gateway returned ${res.status}` },
        { status: 502 }
      );
    }

    const result = await res.json();

    if (result.errors?.length) {
      return Response.json(
        { error: result.errors[0].message },
        { status: 502 }
      );
    }

    const prices: PricePoint[] =
      result.data?.v4Pool?.priceHistory ?? [];

    return Response.json({ data: prices });
  } catch (err) {
    console.error("[pool-prices] error:", err);
    return Response.json({ error: "Failed to fetch prices" }, { status: 500 });
  }
}
