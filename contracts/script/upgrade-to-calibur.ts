import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const CALIBUR_V100: Address = "0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00";

async function main() {
  const pk = process.env.UPGRADE_PRIVATE_KEY as Hex | undefined;
  const rpcUrl = process.env.UPGRADE_RPC_URL ?? "https://mainnet.base.org";
  const target = (process.env.CALIBUR_TARGET as Address | undefined) ?? CALIBUR_V100;

  if (!pk || !pk.startsWith("0x")) {
    throw new Error("Set UPGRADE_PRIVATE_KEY=0x... in contracts/.env (never commit it)");
  }

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

  console.log(`EOA:    ${account.address}`);
  console.log(`Target: ${target}`);

  const before = (await publicClient.getCode({ address: account.address })) ?? "0x";
  console.log(`Code before: ${before === "0x" ? "(empty EOA)" : before}`);
  if (before.toLowerCase().startsWith(`0xef0100${target.toLowerCase().slice(2)}`)) {
    console.log("Already delegated to Calibur. Nothing to do.");
    return;
  }

  const pending = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  console.log(`Pending nonce: ${pending} | chainId: ${base.id}`);
  console.log("Signing 7702 authorization...");
  const authorization = await walletClient.signAuthorization({
    contractAddress: target,
    chainId: base.id,
    executor: "self",
  });
  console.log(`Auth nonce (pending+1 for self-call): ${(authorization as any).nonce}`);

  console.log("Broadcasting type-4 transaction...");
  const hash = await walletClient.sendTransaction({
    to: account.address,
    data: "0x",
    value: 0n,
    authorizationList: [authorization],
    chain: base,
  } as any);
  console.log(`TX: https://basescan.org/tx/${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Mined in block ${receipt.blockNumber} (${receipt.status})`);

  const after = (await publicClient.getCode({ address: account.address })) ?? "0x";
  console.log(`Code after:  ${after === "0x" ? "(still empty - authorization was skipped)" : after}`);
  if (after.toLowerCase().startsWith(`0xef0100${target.toLowerCase().slice(2)}`)) {
    console.log("OK - EOA is now a Calibur smart wallet. Reconnect the dapp and Delegate.");
  } else {
    throw new Error("Code mismatch after mining. Do NOT retry blindly - inspect the receipt first.");
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e?.shortMessage ?? e?.message ?? e}`);
  process.exit(1);
});
