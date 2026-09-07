import { AQUA_BASE, aquaHeaders, getApiKey } from "@/lib/aqua-api";
import { getCached, setCached } from "@/lib/aqua-cache";

export const dynamic = "force-dynamic";

const TTL_MS = 60 * 1000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const maker = searchParams.get("maker");
  if (!maker || !/^0x[a-fA-F0-9]{40}$/.test(maker)) {
    return Response.json({ error: "maker required" }, { status: 400 });
  }
  const chainIds = searchParams.getAll("chainIds").map(Number).filter(Boolean);
  const limit = Math.min(Number(searchParams.get("limit") ?? 20) || 20, 50);

  const key = `positions|${maker.toLowerCase()}|${[...chainIds].sort().join(",")}|${limit}`;
  const hit = await getCached<unknown>(key, TTL_MS);
  if (hit) return Response.json({ items: hit, cached: true });

  const params = new URLSearchParams({ limit: String(limit) });
  (chainIds.length > 0 ? chainIds : [8453]).forEach((id) =>
    params.append("chainIds", String(id))
  );
  const res = await fetch(`${AQUA_BASE}/strategies/makers/${maker}?${params}`, {
    headers: aquaHeaders(getApiKey()),
  });
  if (!res.ok) {
    return Response.json({ error: `Aqua API ${res.status}` }, { status: 502 });
  }
  const json = await res.json();
  const items = Array.isArray(json) ? json : (json.items ?? []);
  await setCached(key, items);
  return Response.json({ items, cached: false });
}
