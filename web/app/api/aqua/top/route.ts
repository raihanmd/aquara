import { fetchTopPositions, getApiKey } from "@/lib/aqua-api";
import { getCached, setCached } from "@/lib/aqua-cache";

export const dynamic = "force-dynamic";

const TTL_MS = 5 * 60 * 1000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chainIds = searchParams.getAll("chainIds").map(Number).filter(Boolean);
  const limit = Math.min(Number(searchParams.get("limit") ?? 3) || 3, 12);
  const sortBy = searchParams.get("sortBy") === "apy" ? "apy" : "volume";

  const key = `top|${[...chainIds].sort().join(",")}|${limit}|${sortBy}`;
  const hit = await getCached<unknown>(key, TTL_MS);
  if (hit) return Response.json({ data: hit, cached: true });

  const data = await fetchTopPositions(
    chainIds.length > 0 ? chainIds : [8453],
    limit,
    sortBy as "apy" | "volume",
    getApiKey()
  );
  await setCached(key, data);
  return Response.json({ data, cached: false });
}
