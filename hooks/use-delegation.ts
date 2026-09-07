"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { base } from "wagmi/chains";
import type { Address, Hex } from "viem";

// EIP-712 types for Calibur's SignedBatchedCall (root key, permissionless relay)
const EIP712_TYPES = {
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
};
import {
  CALIBUR_ADDRESS,
  GUARDED_EXECUTOR_HOOK,
  caliburAbi,
  API_URL,
} from "@/lib/delegation/constants";
import {
  computeKeyHash,
  buildDelegationCalls,
  buildRevokeCall,
  parse7702Target,
  verifyCaliburAccount,
  readCaliburDomain,
} from "@/lib/delegation/actions";
export type DelegationStatus =
  | "unknown"
  | "not-delegated"
  | "delegated"
  | "checking";

export function useDelegation() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const [status, setStatus] = useState<DelegationStatus>("unknown");
  const [agentAddress, setAgentAddress] = useState<Address | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [hasCaliburCode, setHasCaliburCode] = useState(false);
  const [delegatedTo, setDelegatedTo] = useState<Address | null>(null);

  // Fetch agent address from env first, then backend
  useEffect(() => {
    const envAgent = process.env.NEXT_PUBLIC_AGENT_ADDRESS as Address | undefined;
    if (envAgent) {
      setAgentAddress(envAgent);
      return;
    }
    fetch(`${API_URL}/api/agent`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.address) setAgentAddress(data.address as Address);
      })
      .catch(() => {});
  }, []);

  // Check delegation status (retries reads: public RPCs 429 flaky reads
  // must not flip a delegated user back to "Delegate")
  const checkDelegation = useCallback(async () => {
    if (!address || !publicClient || !agentAddress) return;
    const userAddress: Address = address;
    const client = publicClient;
    const agent = agentAddress;
    setStatus("checking");

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let lastErr: any = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await checkDelegationOnce();
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(800 * attempt);
      }
    }
    console.warn(
      "[delegation] status check failed after retries - keeping last known state:",
      lastErr?.shortMessage || lastErr?.message || lastErr
    );

    async function checkDelegationOnce() {
      const impl = await verifyCaliburAccount(client, userAddress);
      setHasCaliburCode(!!impl);
      setDelegatedTo(impl);

      if (!impl) {
        setStatus("not-delegated");
        return;
      }

      const keyHash = computeKeyHash(agent);
      const isRegistered = await client.readContract({
        address: userAddress,
        abi: caliburAbi,
        functionName: "isRegistered",
        args: [keyHash],
      });

      if (!isRegistered) {
        setStatus("not-delegated");
        return;
      }

      // Also check if hook is set (key settings != 0 means hook+expiry configured)
      // Read errors propagate to the retry loop above - only definitive
      // negatives settle the status here.
      const settings = await client.readContract({
        address: userAddress,
        abi: [{ name: "getKeySettings", type: "function", stateMutability: "view", inputs: [{ name: "keyHash", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] }],
        functionName: "getKeySettings",
        args: [keyHash],
      }) as bigint;
      // Settings is packed: (expiry << 160) | hookAddress
      // Verify the hook address matches the current GUARDED_EXECUTOR_HOOK
      const hookInSettings = settings & ((1n << 160n) - 1n);
      const expectedHook = BigInt(GUARDED_EXECUTOR_HOOK);
      if (settings === 0n || hookInSettings !== expectedHook) {
        // Hook not set, or set to old/wrong hook - needs re-delegation
        setStatus("not-delegated");
      } else {
        setStatus("delegated");
      }
    }
  }, [address, publicClient, agentAddress]);

  useEffect(() => {
    checkDelegation();
  }, [checkDelegation]);

  const ensureBaseChain = useCallback(async (): Promise<void> => {
    const provider = (window as any).ethereum;
    if (!provider) return;
    let chainId: number | null = null;
    try {
      const hex = (await provider.request({ method: "eth_chainId" })) as string;
      chainId = parseInt(hex, 16);
    } catch {
      chainId = null;
    }
    if (chainId !== null && chainId !== 8453) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x2105" }],
        });
      } catch (switchErr: any) {
        if (switchErr?.code === 4902) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: "0x2105",
              chainName: "Base",
              rpcUrls: ["https://mainnet.base.org"],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              blockExplorerUrls: ["https://basescan.org"],
            }],
          });
        } else if (switchErr?.code === 4001) {
          throw new Error("Chain switch rejected - please switch to Base (8453) to continue.");
        } else {
          throw new Error(
            switchErr?.message || "Failed to switch to Base (8453). Please switch manually."
          );
        }
      }
    }
  }, []);

  const perform7702Delegation = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient || !walletClient) {
      setError("Wallet not connected");
      return false;
    }
    try {
      const authorization = await walletClient.signAuthorization({
        contractAddress: CALIBUR_ADDRESS,
        chainId: base.id,
        executor: "self",
      });
      const hash = await walletClient.sendTransaction({
        to: address,
        data: "0x",
        authorizationList: [authorization],
        chain: base,
      } as any);
      await publicClient.waitForTransactionReceipt({ hash });
      const code = await publicClient.getCode({ address });
      if (parse7702Target(code)?.toLowerCase() !== CALIBUR_ADDRESS.toLowerCase()) {
        setError("7702 delegation failed - code not set. Try again.");
        return false;
      }
      setHasCaliburCode(true);
      return true;
    } catch (err: any) {
      const msg = `${err?.shortMessage || ""} ${err?.message || ""}`.toLowerCase();
      if (err?.code === 4001) {
        setError("Authorization rejected - please approve to activate smart wallet.");
      } else if (msg.includes("json-rpc") && msg.includes("not supported")) {
        setError(
          "Your wallet can't sign 7702 authorizations from a dapp. " +
            "Enable Smart Wallet inside Uniswap Wallet (it delegates to Calibur automatically), then reconnect."
        );
      } else {
        setError(err?.shortMessage || err?.message || "Failed to activate smart wallet");
      }
      return false;
    }
  }, [address, publicClient, walletClient]);

  const enableCalibur = useCallback(async (): Promise<boolean> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const ok = await perform7702Delegation();
      if (ok) await checkDelegation();
      return ok;
    } finally {
      setIsSubmitting(false);
    }
  }, [perform7702Delegation, checkDelegation]);

  const signAndRelay = useCallback(
    async (calls: { to: Address; value: bigint; data: Hex }[]): Promise<Hex> => {
      if (!address || !publicClient) throw new Error("Wallet not connected");
      const provider = (window as any).ethereum;
      if (!provider) throw new Error("No wallet provider");

      const code = await publicClient.getCode({ address });
      const impl = parse7702Target(code);
      if (!impl) throw new Error("Account is not a Calibur smart wallet");
      const caliburDomain = await readCaliburDomain(publicClient, address, impl);

      const seq = (await publicClient.readContract({
        address,
        abi: caliburAbi,
        functionName: "getSeq",
        args: [0n],
      })) as bigint;

      const signedBatchedCall = {
        batchedCall: {
          calls: calls.map((c) => ({
            to: c.to,
            value: c.value.toString(),
            data: c.data,
          })),
          revertOnFailure: true,
        },
        nonce: seq.toString(),
        keyHash:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        executor: "0x0000000000000000000000000000000000000000",
        deadline: "0",
      };

      const domain = {
        name: caliburDomain.name,
        version: caliburDomain.version,
        chainId: caliburDomain.chainId,
        verifyingContract: address,
        salt: caliburDomain.salt,
      };

      const signature: Hex = await provider.request({
        method: "eth_signTypedData_v4",
        params: [
          address,
          JSON.stringify({
            types: {
              EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
                { name: "chainId", type: "uint256" },
                { name: "verifyingContract", type: "address" },
                { name: "salt", type: "bytes32" },
              ],
              ...EIP712_TYPES,
            },
            primaryType: "SignedBatchedCall",
            domain,
            message: signedBatchedCall,
          }),
        ],
      });

      const res = await fetch(`${API_URL}/api/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress: address, signedBatchedCall, signature, domain }),
      });

      const result = await res.json();
      if (!result.ok) throw new Error(result.error || "Relay failed");

      await publicClient.waitForTransactionReceipt({ hash: result.txHash as Hex });
      return result.txHash as Hex;
    },
    [address, publicClient]
  );

  // Delegation via SignedBatchedCall:
  // 1. User signs EIP-712 typed data (no transaction, no self-call)
  // 2. Backend relayer calls execute(SignedBatchedCall, signature) on user's EOA
  const delegate = useCallback(
    async (positionIds?: string[]): Promise<boolean> => {
      if (!address || !publicClient || !agentAddress) {
        setError("Wallet not connected or agent not loaded");
        return false;
      }

      setIsSubmitting(true);
      setError(null);
      setTxHash(null);
      let stage = "init";

      try {
        stage = "chain-check";
        await ensureBaseChain();

        stage = "read-code";
        const impl = await verifyCaliburAccount(publicClient, address);
        if (!impl) {
          const raw = parse7702Target(await publicClient.getCode({ address }));
          if (raw) {
            throw new Error(
              `This account is a smart wallet delegated to ${raw}, which is not Calibur. ` +
                "Connect a Calibur smart wallet (Uniswap Wallet enables it automatically) or an undelegated EOA."
            );
          }
          const ok7702 = await perform7702Delegation();
          if (!ok7702) return false;
        }

        stage = "build-calls";
        // Build delegation calls - use actual user address for self-calls
        // (address(0) only works with wallet_sendCalls, not with Calibur relay)
        const allCalls = buildDelegationCalls({
          userAddress: address,
          agentAddress,
        });

        // Check if key is already registered - skip register if so
        const keyHash = computeKeyHash(agentAddress);
        const alreadyRegistered = await publicClient.readContract({
          address,
          abi: caliburAbi,
          functionName: "isRegistered",
          args: [keyHash],
        });

        // allCalls[0] = register, allCalls[1..N-1] = setCanExecute, allCalls[N] = update
        const calls = alreadyRegistered ? allCalls.slice(1) : allCalls;

        stage = "sign+relay";
        const txHash = await signAndRelay(calls);

        setTxHash(txHash);
        setStatus("delegated");
        return true;
      } catch (err: any) {
        console.error("[delegate] failed at stage:", stage, err);
        setError(err.shortMessage || err.message || "Delegation failed");
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [address, publicClient, agentAddress, perform7702Delegation, signAndRelay, ensureBaseChain]
  );

  const revoke = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient || !agentAddress) {
      setError("Wallet not connected or agent not loaded");
      return false;
    }

    setIsSubmitting(true);
    setError(null);
    let stage = "init";

    try {
      stage = "chain-check";
      await ensureBaseChain();

      stage = "check-registered";
      const keyHash = computeKeyHash(agentAddress);
      const registered = await publicClient.readContract({
        address,
        abi: caliburAbi,
        functionName: "isRegistered",
        args: [keyHash],
      });
      if (!registered) {
        setStatus("not-delegated");
        return true;
      }

      stage = "sign+relay";
      const txHash = await signAndRelay([buildRevokeCall(address, keyHash)]);
      setTxHash(txHash);

      stage = "cleanup";
      try {
        const delRes = await fetch(`/api/users?address=${address}`, {
          method: "DELETE",
        });
        if (!delRes.ok) {
          console.warn("[revoke] managed-user delete returned", delRes.status);
        }
      } catch (e) {
        console.warn("[revoke] managed-user delete failed:", e);
      }

      // Trust the relayed receipt - don't re-read chain immediately while
      // public RPCs may still serve pre-revoke state. Re-confirm later.
      setStatus("not-delegated");
      window.setTimeout(() => {
        checkDelegation().catch(() => {});
      }, 15000);
      return true;
    } catch (err: any) {
      console.error("[revoke] failed at stage:", stage, err);
      const detail =
        (err as any)?.details ||
        (err as any)?.cause?.message;
      if (typeof detail === "string" && detail.length > 0) {
        setError(detail);
      } else {
        setError(err.shortMessage || err.message || "Revoke failed");
      }
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [address, publicClient, agentAddress, signAndRelay, checkDelegation, ensureBaseChain]);

  return {
    status,
    agentAddress,
    hasCaliburCode,
    delegatedTo,
    isSubmitting,
    error,
    txHash,
    delegate,
    revoke,
    enableCalibur,
    checkDelegation,
  };
}
