"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { base } from "wagmi/chains";
import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
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

export function useDelegation() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [status, setStatus] = useState<DelegationStatus>("unknown");
  const [agentAddress, setAgentAddress] = useState<Address | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [hasCaliburCode, setHasCaliburCode] = useState(false);

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

  const perform7702Delegation = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient || !walletClient) {
      setError("Wallet not connected");
      return false;
    }
    try {
      const authorization = await walletClient.signAuthorization({
        contractAddress: CALIBUR_ADDRESS,
      });
      const hash = await walletClient.sendTransaction({
        to: address,
        data: "0x",
        authorizationList: [authorization],
        chain: base,
      } as any);
      await publicClient.waitForTransactionReceipt({ hash });
      const code = await publicClient.getCode({ address });
      if (!isCaliburDelegated(code)) {
        setError("7702 delegation failed — code not set. Try again.");
        return false;
      }
      setHasCaliburCode(true);
      return true;
    } catch (err: any) {
      const msg = `${err?.shortMessage || ""} ${err?.message || ""}`.toLowerCase();
      if (err?.code === 4001) {
        setError("Authorization rejected — please approve to activate smart wallet.");
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
          const ok7702 = await perform7702Delegation();
          if (!ok7702) return false;
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

        if (!provider) throw new Error("No wallet provider");
        if (!walletClient) throw new Error("Wallet not connected");
        const directCalldata = encodeFunctionData({
          abi: caliburAbi,
          functionName: "execute",
          args: [
            {
              calls: calls.map((c) => ({
                to: c.to,
                value: c.value,
                data: c.data,
              })),
              revertOnFailure: true as const,
            },
          ],
        });
        const txHash = await walletClient.sendTransaction({
          to: address,
          data: directCalldata,
          value: 0n,
          chain: base,
        } as any);

        setTxHash(txHash as Hex);
        await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });

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
    [address, publicClient, agentAddress, perform7702Delegation]
  );

  return {
    status,
    agentAddress,
    hasCaliburCode,
    isSubmitting,
    error,
    txHash,
    delegate,
    enableCalibur,
    checkDelegation,
  };
}
