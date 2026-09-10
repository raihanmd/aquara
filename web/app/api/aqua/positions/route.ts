import { fetchMakerPositions, getApiKey } from "@/lib/aqua-api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const maker = searchParams.get("maker");
  if (!maker || !/^0x[a-fA-F0-9]{40}$/.test(maker)) {
    return Response.json({ error: "maker required" }, { status: 400 });
  }
  const chainIds = searchParams.getAll("chainIds").map(Number).filter(Boolean);
  const limit = Math.min(Number(searchParams.get("limit") ?? 20) || 20, 50);

  try {
    const items = await fetchMakerPositions(maker, getApiKey(), limit, chainIds);
    return Response.json({ items });
  } catch (e) {
    return Response.json(
      { error: `Aqua API unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)}` },
      { status: 502 },
    );
  }
}
