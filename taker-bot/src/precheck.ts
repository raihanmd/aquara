import { createPublicClient, http, formatGwei } from "viem";
import { base } from "viem/chains";

export interface SimTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  from?: `0x${string}`;
}

export interface PrecheckReport {
  ok: boolean;
  reason: string;
  gasEstimate?: bigint;
  gasCostWei?: bigint;
}

export function rpcClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

// Gate 1: eth_call simulation. Any revert (no fill route, bad params,
// predicate fail) stops the tick before a single wei of gas is spent.
export async function simulateTx(
  client: ReturnType<typeof rpcClient>,
  tx: SimTx
): Promise<PrecheckReport> {
  try {
    await client.call({
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      ...(tx.from ? { account: tx.from } : {}),
    });
    const gas = await client
      .estimateGas({
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        ...(tx.from ? { account: tx.from } : {}),
      })
      .catch(() => 0n);
    return { ok: true, reason: "simulation-pass", gasEstimate: gas };
  } catch (e: any) {
    const msg = e?.shortMessage || e?.message || "unknown";
    return { ok: false, reason: `simulation-revert: ${msg}`.slice(0, 200) };
  }
}

// Gate 2: quoted-out vs expected-out deviation. A fill that does not route
// through our position shows up here as unexpected output.
export function checkDeviation(
  expectedOut: bigint,
  quotedOut: bigint,
  maxBps: number
): { ok: boolean; reason: string } {
  if (expectedOut <= 0n) return { ok: false, reason: "expected-out non-positive" };
  const diff = expectedOut > quotedOut ? expectedOut - quotedOut : quotedOut - expectedOut;
  const bps = Number((diff * 10000n) / expectedOut);
  if (bps > maxBps) {
    return { ok: false, reason: `deviation ${bps}bps over max ${maxBps}bps - not our route` };
  }
  return { ok: true, reason: `deviation ${bps}bps within max ${maxBps}bps` };
}

// Gate 3: gas economics. Demo budget is finite - a fill must not cost more
// than the fee volume it is expected to accrue.
export function checkGasEconomics(
  gasCostWei: bigint,
  expectedFeeWei: bigint
): { ok: boolean; reason: string } {
  if (gasCostWei > expectedFeeWei) {
    return {
      ok: false,
      reason: `gas ${formatGwei(gasCostWei)} gwei over expected fee ${formatGwei(expectedFeeWei)} gwei`,
    };
  }
  return { ok: true, reason: "gas within fee budget" };
}
