"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { Address, Hex } from "viem";
import {
  CALIBUR_ADDRESS,
  GUARDED_EXECUTOR_HOOK,
  caliburAbi,
  API_URL,
} from "@/lib/delegation/constants";
import {
  computeKeyHash,
  buildDelegationCalls,
} from "@/lib/delegation/actions";
import { syncSettingsToBackend, type AquaSettings } from "@/hooks/use-settings";

export type DelegationStatus =
  | "unknown"
  | "not-delegated"
  | "delegated"
  | "checking";

function isCaliburDelegated(code: string | undefined): boolean {
  if (!code || code === "0x" || code.length <= 4) return false;
  const caliburLower = CALIBUR_ADDRESS.toLowerCase().slice(2);
  return code.toLowerCase().startsWith("0xef0100" + caliburLower);
}

// EIP-712 types for Calibur's SignedBatchedCall
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

export function useDelegation() {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [status, setStatus] = useState<DelegationStatus>("unknown");
  const [agentAddress, setAgentAddress] = useState<Address | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [hasCaliburCode, setHasCaliburCode] = useState(false);

  // Fetch agent address from backend
  useEffect(() => {
    fetch(`${API_URL}/api/agent`)
      .then((r) => r.json())
      .then((data) => setAgentAddress(data.address as Address))
      .catch(() => {});
  }, []);

  // Check delegation status
  const checkDelegation = useCallback(async () => {
    if (!address || !publicClient || !agentAddress) return;
    setStatus("checking");

    try {
      const code = await publicClient.getCode({ address });
      const hasCal = isCaliburDelegated(code);
      setHasCaliburCode(hasCal);

      if (!hasCal) {
        setStatus("not-delegated");
        return;
      }

      const keyHash = computeKeyHash(agentAddress);
      const isRegistered = await publicClient.readContract({
        address,
        abi: caliburAbi,
        functionName: "isRegistered",
        args: [keyHash],
      });

      if (!isRegistered) {
        setStatus("not-delegated");
        return;
      }

      // Also check if hook is set (key settings != 0 means hook+expiry configured)
      try {
        const settings = await publicClient.readContract({
          address,
          abi: [{ name: "getKeySettings", type: "function", stateMutability: "view", inputs: [{ name: "keyHash", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] }],
          functionName: "getKeySettings",
          args: [keyHash],
        }) as bigint;
        // Settings is packed: (expiry << 160) | hookAddress
        // Verify the hook address matches the current GUARDED_EXECUTOR_HOOK
        const hookInSettings = settings & ((1n << 160n) - 1n);
        const expectedHook = BigInt(GUARDED_EXECUTOR_HOOK);
        if (settings === 0n || hookInSettings !== expectedHook) {
          // Hook not set, or set to old/wrong hook — needs re-delegation
          setStatus("not-delegated");
        } else {
          setStatus("delegated");
        }
      } catch {
        setStatus("not-delegated");
      }
    } catch {
      setStatus("not-delegated");
    }
  }, [address, publicClient, agentAddress]);

  useEffect(() => {
    checkDelegation();
  }, [checkDelegation]);

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

      try {
        // Switch wallet to Base before signing
        const provider = (window as any).ethereum;
        if (provider) {
          try {
            await provider.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: "0x2105" }], // 8453 in hex
            });
          } catch (switchErr: any) {
            // 4902 = chain not added — try adding it
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
            }
          }
        }

        const code = await publicClient.getCode({ address });
        if (!isCaliburDelegated(code)) {
          throw new Error(
            "Your wallet is not delegated to Calibur. " +
            "Please use a Uniswap Wallet with Smart Wallet enabled."
          );
        }

        // Build delegation calls — use actual user address for self-calls
        // (address(0) only works with wallet_sendCalls, not with Calibur relay)
        const allCalls = buildDelegationCalls({
          userAddress: address,
          agentAddress,
        });

        // Check if key is already registered — skip register if so
        const keyHash = computeKeyHash(agentAddress);
        const alreadyRegistered = await publicClient.readContract({
          address,
          abi: caliburAbi,
          functionName: "isRegistered",
          args: [keyHash],
        });

        // allCalls[0] = register, allCalls[1..N-1] = setCanExecute, allCalls[N] = update
        const calls = alreadyRegistered ? allCalls.slice(1) : allCalls;

        // Get nonce from Calibur's NonceManager (key=0 for root)
        const seq = await publicClient.readContract({
          address,
          abi: caliburAbi,
          functionName: "getSeq",
          args: [0n],
        }) as bigint;
        // Nonce format: (nonceKey << 64) | seq
        const nonce = seq; // nonceKey=0, so nonce = seq

        // Build the SignedBatchedCall message
        const signedBatchedCall = {
          batchedCall: {
            calls: calls.map((c) => ({
              to: c.to,
              value: c.value.toString(),
              data: c.data,
            })),
            revertOnFailure: true,
          },
          nonce: nonce.toString(),
          keyHash: "0x0000000000000000000000000000000000000000000000000000000000000000", // root key
          executor: "0x0000000000000000000000000000000000000000", // anyone can execute
          deadline: "0", // no expiry
        };

        // EIP-712 domain from Calibur's eip712Domain() — includes salt
        const domain = {
          name: "Calibur",
          version: "1.0.0",
          chainId: 8453,
          verifyingContract: address,
          salt: "0x000000000000000000000000000000009b1d0af20d8c6d0a44e162d11f9b8f00",
        };

        if (!provider) throw new Error("No wallet provider");

        // Ask user to sign the EIP-712 typed data
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

        // Send to backend relayer — it calls execute(SignedBatchedCall, signature) on user's EOA
        const res = await fetch(`${API_URL}/api/delegate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userAddress: address,
            signedBatchedCall: {
              batchedCall: {
                calls: calls.map((c) => ({
                  to: c.to,
                  value: c.value.toString(),
                  data: c.data,
                })),
                revertOnFailure: true,
              },
              nonce: nonce.toString(),
              keyHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
              executor: "0x0000000000000000000000000000000000000000",
              deadline: "0",
            },
            signature,
            positions: positionIds ?? [],
          }),
        });

        const result = await res.json();
        if (!result.ok) throw new Error(result.error || "Relay failed");

        setTxHash(result.txHash as Hex);
        await publicClient.waitForTransactionReceipt({ hash: result.txHash });

        // Sync current settings to backend so rebalancer uses them from the start
        try {
          const STORAGE_KEY = "aqua-settings";
          const raw = localStorage.getItem(STORAGE_KEY);
          const currentSettings: AquaSettings = raw
            ? JSON.parse(raw)
            : { riskProfile: "medium", maxSlippage: 50, autoRebalance: true };
          await syncSettingsToBackend(address, currentSettings);
        } catch {
          // Settings sync is best-effort
        }

        setStatus("delegated");
        return true;
      } catch (err: any) {
        setError(err.shortMessage || err.message || "Delegation failed");
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [address, publicClient, agentAddress]
  );

  return {
    status,
    agentAddress,
    hasCaliburCode,
    isSubmitting,
    error,
    txHash,
    delegate,
    checkDelegation,
  };
}
