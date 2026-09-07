import { z } from "zod";
import {
  isAddress,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const caliburExecuteAbi = [
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

const bodySchema = z.object({
  userAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  signedBatchedCall: z.unknown(),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "userAddress, signedBatchedCall, signature required" }, { status: 400 });
  }
  const { userAddress, signedBatchedCall, signature } = parsed.data as {
    userAddress: string;
    signedBatchedCall: any;
    signature: string;
  };

  const relayerPk = (process.env.RELAYER_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY) as
    | `0x${string}`
    | undefined;
  if (!relayerPk) {
    return Response.json(
      { error: "Relayer not configured (RELAYER_PRIVATE_KEY). Fund the agent and set the key." },
      { status: 500 }
    );
  }

  try {
    const batch = {
      batchedCall: {
        calls: (signedBatchedCall.batchedCall.calls as any[]).map((c: any) => ({
          to: c.to as Address,
          value: BigInt(c.value),
          data: c.data as Hex,
        })),
        revertOnFailure: signedBatchedCall.batchedCall.revertOnFailure as boolean,
      },
      nonce: BigInt(signedBatchedCall.nonce),
      keyHash: signedBatchedCall.keyHash as Hex,
      executor: signedBatchedCall.executor as Address,
      deadline: BigInt(signedBatchedCall.deadline),
    };

    const wrappedSignature = encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }],
      [signature as Hex, "0x" as Hex]
    );

    const calldata = encodeFunctionData({
      abi: caliburExecuteAbi,
      functionName: "execute",
      args: [batch, wrappedSignature],
    });

    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.base.org";

    // Gas-griefing guard: verify the root signature recovers to the user
    // BEFORE spending relayer gas. Invalid sigs get 400, never reach chain.
    const { recoverTypedDataAddress } = await import("viem");
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "Calibur",
        version: "1.0.0",
        chainId: 8453,
        verifyingContract: userAddress as Address,
        salt: "0x000000000000000000000000000000009b1d0af20d8c6d0a44e162d11f9b8f00",
      } as any,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
          { name: "salt", type: "bytes32" },
        ],
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
      } as any,
      primaryType: "SignedBatchedCall",
      message: {
        batchedCall: {
          calls: (signedBatchedCall.batchedCall.calls as any[]).map((c: any) => ({
            to: c.to as Address,
            value: BigInt(c.value),
            data: c.data as Hex,
          })),
          revertOnFailure: signedBatchedCall.batchedCall.revertOnFailure as boolean,
        },
        nonce: BigInt(signedBatchedCall.nonce),
        keyHash: signedBatchedCall.keyHash as Hex,
        executor: signedBatchedCall.executor as Address,
        deadline: BigInt(signedBatchedCall.deadline),
      } as any,
      signature: signature as Hex,
    });
    if (recovered.toLowerCase() !== (userAddress as string).toLowerCase()) {
      return Response.json({ error: "Signature does not match userAddress" }, { status: 400 });
    }

    const account = privateKeyToAccount(relayerPk);
    const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

    const txHash = await walletClient.sendTransaction({
      to: userAddress as Address,
      data: calldata,
      value: 0n,
      gas: 1_000_000n,
      chain: base,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    await prisma.managedUser.upsert({
      where: { address: userAddress.toLowerCase() },
      update: { chainId: 8453, txHash },
      create: { address: userAddress.toLowerCase(), chainId: 8453, txHash },
    });

    return Response.json({ ok: true, txHash, status: receipt.status });
  } catch (e: any) {
    return Response.json(
      { error: e?.shortMessage || e?.message || "Relay failed" },
      { status: 500 }
    );
  }
}
