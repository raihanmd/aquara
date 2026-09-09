import type { Address, Hex } from "viem";

export interface DeployIntent {
  maker: string;
  capital: string;
  capitalAmount: string;
  pairs: { tokenA: string; tokenB: string }[];
  mode: string;
  nonce: string;
  expiry: string;
}

export function buildDeployMessage(i: DeployIntent): string {
  const pairList = i.pairs.map((p) => `${p.tokenA.toLowerCase()}/${p.tokenB.toLowerCase()}`).join(",");
  return [
    "Deploy to Aqua via Aquara",
    `maker: ${i.maker.toLowerCase()}`,
    `capital: ${i.capital.toLowerCase()} amount: ${i.capitalAmount}`,
    `pairs: [${pairList}]`,
    `mode: ${i.mode}`,
    `nonce: ${i.nonce}`,
    `expiry: ${i.expiry}`,
  ].join("\n");
}

const seenDigests = new Set<string>();
setInterval(() => {
  if (seenDigests.size > 10000) seenDigests.clear();
}, 60_000).unref?.();

export async function verifyDeployIntent(
  body: Record<string, unknown>,
  signature: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const intent = body as unknown as DeployIntent;
  if (
    !intent ||
    typeof intent.maker !== "string" ||
    typeof intent.capital !== "string" ||
    typeof intent.capitalAmount !== "string" ||
    !Array.isArray(intent.pairs) ||
    typeof intent.mode !== "string" ||
    typeof intent.nonce !== "string" ||
    typeof intent.expiry !== "string" ||
    typeof signature !== "string" ||
    !/^0x[a-fA-F0-9]+$/.test(signature)
  ) {
    return { ok: false, error: "signature, nonce, expiry required" };
  }
  const now = Date.now();
  const expiryMs = Number(intent.expiry);
  const nonceMs = Number(intent.nonce);
  if (!isFinite(expiryMs) || !isFinite(nonceMs)) {
    return { ok: false, error: "bad nonce/expiry" };
  }
  if (expiryMs <= now) return { ok: false, error: "intent expired - sign again" };
  if (Math.abs(now - nonceMs) > 10 * 60 * 1000 || nonceMs > now + 60_000) {
    return { ok: false, error: "stale intent - sign again" };
  }
  const message = buildDeployMessage(intent);
  const { recoverMessageAddress, keccak256, toBytes } = await import("viem");
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature: signature as Hex });
  } catch {
    return { ok: false, error: "bad signature" };
  }
  if (signer.toLowerCase() !== intent.maker.toLowerCase()) {
    return { ok: false, error: "signature does not match maker" };
  }
  const digest = keccak256(toBytes(`${message}|${signature.toLowerCase()}`));
  if (seenDigests.has(digest)) return { ok: false, error: "intent already used" };
  seenDigests.add(digest);
  return { ok: true };
}
