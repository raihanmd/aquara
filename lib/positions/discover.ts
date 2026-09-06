const UNISWAP_V4_SUBGRAPH_ID = "Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj";

function getSubgraphUrl(): string | null {
  const key = process.env.NEXT_PUBLIC_GRAPH_API_KEY;
  if (!key) return null;
  return `https://gateway.thegraph.com/api/${key}/subgraphs/id/${UNISWAP_V4_SUBGRAPH_ID}`;
}

const QUERY = `
  query GetPositions($owner: String!) {
    positions(
      where: { owner: $owner }
      first: 100
      orderBy: createdAtTimestamp
      orderDirection: desc
    ) {
      id
      tokenId
      owner
    }
  }
`;

const CACHE_KEY = "aqua-discovered-positions";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedDiscovery {
  owner: string;
  positions: { tokenId: string }[];
  timestamp: number;
}

function getCached(owner: string): { tokenId: string }[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedDiscovery = JSON.parse(raw);
    if (cached.owner.toLowerCase() !== owner.toLowerCase()) return null;
    if (Date.now() - cached.timestamp > CACHE_TTL) return null;
    return cached.positions;
  } catch {
    return null;
  }
}

function setCache(owner: string, positions: { tokenId: string }[]) {
  if (typeof window === "undefined") return;
  try {
    const data: CachedDiscovery = { owner, positions, timestamp: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
}

export function clearDiscoveryCache() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(CACHE_KEY);
}

export interface DiscoveredPosition {
  tokenId: string;
}

export async function discoverPositions(
  ownerAddress: string,
  skipCache = false
): Promise<DiscoveredPosition[]> {
  if (!skipCache) {
    const cached = getCached(ownerAddress);
    if (cached) return cached;
  }

  const url = getSubgraphUrl();
  if (!url) {
    console.warn("[discover] No NEXT_PUBLIC_GRAPH_API_KEY set");
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: { owner: ownerAddress.toLowerCase() },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn("[discover] Subgraph returned", res.status);
      return [];
    }

    const json = await res.json();

    if (json.errors?.length) {
      console.warn("[discover] Subgraph errors:", json.errors[0].message);
      return [];
    }

    const positions = json.data?.positions ?? [];

    const result = positions.map((p: { tokenId: string }) => ({
      tokenId: p.tokenId,
    }));

    setCache(ownerAddress, result);
    return result;
  } catch (err) {
    console.warn("[discover] Failed:", err);
    return [];
  }
}
