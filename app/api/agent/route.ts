import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const dynamic = "force-dynamic";

function resolveAgentAddress(): string | null {
  const fromEnv =
    process.env.NEXT_PUBLIC_AGENT_ADDRESS || process.env.AGENT_ADDRESS;
  if (fromEnv && isAddress(fromEnv)) return fromEnv;
  const pk = process.env.AGENT_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
  if (pk) {
    try {
      return privateKeyToAccount(pk as `0x${string}`).address;
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET() {
  const address = resolveAgentAddress();
  if (!address) {
    return Response.json(
      { error: "Agent not configured (NEXT_PUBLIC_AGENT_ADDRESS)" },
      { status: 500 }
    );
  }
  return Response.json({ address, chainId: 8453 });
}
