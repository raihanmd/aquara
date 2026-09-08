import { getCached, setCached } from "@/lib/aqua-cache";

export const dynamic = "force-dynamic";

const TTL_MS = 60 * 60 * 1000;

export interface TokenListItem {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chainId = Number(searchParams.get("chainIds") ?? 8453) || 8453;

  const key = `tokens|${chainId}`;
  const hit = await getCached<TokenListItem[]>(key, TTL_MS);
  if (hit) return Response.json({ items: hit, cached: true });

  const apiKey = process.env.ONEINCH_API_KEY || process.env.NEXT_PUBLIC_1INCH_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ONEINCH_API_KEY missing" }, { status: 500 });
  }
  const res = await fetch(`https://api.1inch.com/token/v1.2/${chainId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    return Response.json({ error: `Token API ${res.status}` }, { status: 502 });
  }
  const json = await res.json();
  const items: TokenListItem[] = Object.values(json as Record<string, any>)
    .filter((t: any) => t?.address && t?.symbol && typeof t?.decimals === "number")
    .map((t: any) => ({
      address: t.address as string,
      symbol: t.symbol as string,
      name: (t.name as string) ?? (t.symbol as string),
      decimals: t.decimals as number,
      logoURI: t.logoURI as string | undefined,
    }));
  await setCached(key, items);
  return Response.json({ items, cached: false });
}
