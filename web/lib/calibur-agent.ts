import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
  type Account,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base } from "viem/chains";
import { parse7702Target, readCaliburDomain } from "./delegation/actions";

export interface CaliburCall {
  to: Address;
  value: bigint;
  data: Hex;
}

const EXECUTE_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "signedBatchedCall",
        type: "tuple",
        components: [
          {
            name: "batchedCall",
            type: "tuple",
            components: [
              {
                name: "calls",
                type: "tuple[]",
                components: [
                  { name: "to", type: "address" },
                  { name: "value", type: "uint256" },
                  { name: "data", type: "bytes" },
                ],
              },
              { name: "revertOnFailure", type: "bool" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "keyHash", type: "bytes32" },
          { name: "executor", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "wrappedSignature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const GET_SEQ_ABI = [
  {
    name: "getSeq",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function computeKeyHash(agentAddress: Address): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }], [agentAddress]));
  return keccak256(
    encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, inner])
  );
}

export function getAgentAccount(): { account: PrivateKeyAccount; address: Address } {
  const pk = (process.env.RELAYER_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY) as
    | `0x${string}`
    | undefined;
  if (!pk) throw new Error("RELAYER_PRIVATE_KEY missing");
  const account = privateKeyToAccount(pk);
  return { account, address: account.address };
}

function rpcUrl(): string {
  return process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.base.org";
}

export function agentClients() {
  const { account } = getAgentAccount();
  const transport = http(rpcUrl());
  return {
    account,
    address: account.address,
    walletClient: createWalletClient({ account, chain: base, transport }),
    publicClient: createPublicClient({ chain: base, transport }),
  };
}

const TYPES = {
  SignedBatchedCall: [
    { name: "batchedCall", type: "BatchedCall" },
    { name: "nonce", type: "uint256" },
    { name: "keyHash", type: "bytes32" },
    { name: "executor", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
  BatchedCall: [
    { name: "calls", type: "Call[]" },
    { name: "revertOnFailure", type: "bool" },
  ],
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;

// Relayer EOA nonce management. The relayer is shared by concurrent deploy
// jobs, and viem's default pending-nonce read can return a stale value when a
// previous send is still propagating, producing "nonce too low" and
// "replacement transaction underpriced". So all sends from one relayer go
// through a per-address promise chain with an explicit nonce that never goes
// backwards, plus one retry with refreshed nonce and bumped fees.
const submitChains = new Map<string, Promise<unknown>>();
const lastUsedNonces = new Map<string, bigint>();

function enqueueSubmit<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = submitChains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  submitChains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function isNonceError(e: unknown): boolean {
  const err = e as {
    message?: string;
    shortMessage?: string;
    details?: string;
    cause?: unknown;
  };
  const text =
    `${err?.message ?? ""} ${err?.shortMessage ?? ""} ${err?.details ?? ""} ${String(err?.cause ?? "")}`.toLowerCase();
  return (
    text.includes("nonce too low") ||
    text.includes("replacement transaction underpriced") ||
    text.includes("already known")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PreparedBatch {
  seq: bigint;
  calldata: Hex;
}

/** Build + sign a Calibur execute without sending. Free; safe to call for pre-simulation. */
export async function prepareBatch(
  userEOA: Address,
  calls: CaliburCall[],
  deadlineSeconds = 300,
): Promise<PreparedBatch & { account: PrivateKeyAccount }> {
  const { account, publicClient } = agentClients();
  const keyHash = computeKeyHash(account.address);
  const seq = await readSeqOf(publicClient, userEOA);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const impl = parse7702Target(await publicClient.getCode({ address: userEOA }));
  if (!impl) throw new Error("User account is not a Calibur smart wallet");
  const domain = await readCaliburDomain(publicClient, userEOA, impl);
  const message = {
    batchedCall: { calls, revertOnFailure: true as const },
    nonce: seq,
    keyHash,
    executor: account.address,
    deadline,
  };
  const signature = await account.signTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: userEOA,
      salt: domain.salt,
    },
    types: TYPES as any,
    primaryType: "SignedBatchedCall",
    message: message as any,
  });
  const wrappedSignature = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    [signature, "0x"],
  );
  const calldata = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [message as any, wrappedSignature],
  });
  return { seq, calldata, account };
}

function readSeqOf(
  publicClient: ReturnType<typeof agentClients>["publicClient"],
  userEOA: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: userEOA,
    abi: GET_SEQ_ABI,
    functionName: "getSeq",
    args: [0n],
  }) as Promise<bigint>;
}

/**
 * eth_call the EXACT batch calldata (signed for real). Catches batch-level
 * failures before spending gas. Returns null on success, error text on revert.
 */
export async function simulateBatch(
  userEOA: Address,
  calls: CaliburCall[],
): Promise<string | null> {
  const { publicClient } = agentClients();
  try {
    const { calldata } = await prepareBatch(userEOA, calls, 300);
    await publicClient.call({ to: userEOA, data: calldata, value: 0n, account: userEOA });
    return null;
  } catch (e: unknown) {
    const err = e as { shortMessage?: string; message?: string };
    return err?.shortMessage || err?.message || "batch simulation reverted";
  }
}

export async function agentSignAndSubmit(
  userEOA: Address,
  calls: CaliburCall[],
  deadlineSeconds = 300
): Promise<{ txHash: Hex; nonce: bigint }> {
  const { account, walletClient, publicClient } = agentClients();

  const readSeq = () => readSeqOf(publicClient, userEOA);

  // Serialize sends per relayer so concurrent jobs never share a nonce read.
  // The Calibur seq is re-read and re-signed on every attempt: RPC read lag
  // can hand us a stale seq right after our own previous tx mined, which the
  // chain rejects as a replay.
  return enqueueSubmit(account.address.toLowerCase(), async () => {
    let lastErr: unknown = null;
    let { seq, calldata } = await prepareBatch(userEOA, calls, deadlineSeconds);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await sleep(2000 * attempt);
        ({ seq, calldata } = await prepareBatch(userEOA, calls, deadlineSeconds));
      }
      const pending = BigInt(
        await publicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
      );
      const floor = (lastUsedNonces.get(account.address.toLowerCase()) ?? -1n) + 1n;
      const nonce = pending > floor ? pending : floor;
      // Batch-aware gas: estimate per send (batches vary in size), floor at
        // single-call cost, fallback to per-call heuristic on failure.
        let gasLimit = 1_200_000n;
        try {
          const est = await publicClient.estimateGas({
            to: userEOA,
            data: calldata,
            value: 0n,
            account: account.address,
          });
          const buffered = (est * 120n) / 100n;
          gasLimit = buffered > 300_000n ? buffered : 300_000n;
        } catch {
          gasLimit = BigInt(calls.length) * 1_200_000n;
        }
      try {
        const txParams: {
          to: Address;
          data: Hex;
          value: bigint;
          gas: bigint;
          chain: typeof base;
          nonce: number;
          maxFeePerGas?: bigint;
          maxPriorityFeePerGas?: bigint;
        } = {
          to: userEOA,
          data: calldata,
          value: 0n,
          gas: gasLimit,
          chain: base,
          nonce: Number(nonce),
        };
        // Fee policy: estimate-based, scaled by RELAYER_GAS_MULT_BPS
        // (default 100 = network rate, no overpay). Below 100 = slower and
        // cheaper, but risks stuck txs; retries always bump above the first
        // attempt so they never look like underpriced replacements.
        const gasMultRaw = Number(process.env.RELAYER_GAS_MULT_BPS ?? 100);
        const gasMult =
          Number.isFinite(gasMultRaw) && gasMultRaw >= 50 && gasMultRaw <= 500
            ? BigInt(Math.floor(gasMultRaw))
            : 100n;
        const fees = await publicClient.estimateFeesPerGas();
        const baseMaxFee = (fees.maxFeePerGas * gasMult) / 100n;
        const basePrioFee = (fees.maxPriorityFeePerGas * gasMult) / 100n;
        if (attempt === 0) {
          if (gasMult !== 100n) {
            txParams.maxFeePerGas = baseMaxFee;
            txParams.maxPriorityFeePerGas = basePrioFee;
          }
        } else {
          // Bump fees so a retry never looks like an underpriced replacement.
          const bump = 120n + BigInt((attempt - 1) * 25);
          const bumpedMax = (fees.maxFeePerGas * bump) / 100n;
          const bumpedPrio = (fees.maxPriorityFeePerGas * bump) / 100n;
          txParams.maxFeePerGas =
            bumpedMax > baseMaxFee ? bumpedMax : baseMaxFee;
          txParams.maxPriorityFeePerGas =
            bumpedPrio > basePrioFee ? bumpedPrio : basePrioFee;
        }
        const txHash = await walletClient.sendTransaction(txParams);
        lastUsedNonces.set(account.address.toLowerCase(), nonce);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: 120_000,
        });
        if (receipt.status !== "success")
          throw new Error("Batch reverted on-chain");
        return { txHash, nonce: seq };
      } catch (e) {
        lastErr = e;
        const errText = `${(e as { message?: string })?.message ?? e}`;
        if (errText.toLowerCase().includes("timeout")) throw e;
        if (isNonceError(e)) continue;
        if (errText.includes("Batch reverted on-chain")) {
          // Mined but reverted: either a genuine inner-call failure or a
          // stale Calibur seq (replay). Re-read seq: moved means our read
          // lagged behind our own previous tx, so retry re-signed. Unmoved
          // means the calls themselves fail, retrying is pointless.
          const fresh = await readSeq().catch(() => null);
          if (fresh === null || fresh === seq) throw e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Relayer submit failed after retries: ${String(lastErr)}`);
  });
}
