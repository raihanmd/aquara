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

export async function agentSignAndSubmit(
  userEOA: Address,
  calls: CaliburCall[],
  deadlineSeconds = 300
): Promise<{ txHash: Hex; nonce: bigint }> {
  const { account, walletClient, publicClient } = agentClients();
  const keyHash = computeKeyHash(account.address);

  const seq = (await publicClient.readContract({
    address: userEOA,
    abi: GET_SEQ_ABI,
    functionName: "getSeq",
    args: [0n],
  })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  const impl = parse7702Target(
    await publicClient.getCode({ address: userEOA })
  );
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
    [signature, "0x"]
  );

  const calldata = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [message as any, wrappedSignature],
  });

  const txHash = await walletClient.sendTransaction({
    to: userEOA,
    data: calldata,
    value: 0n,
    gas: 1_200_000n,
    chain: base,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("Batch reverted on-chain");
  return { txHash, nonce: seq };
}
