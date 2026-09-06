"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address, Hex } from "viem";
import { API_URL } from "@/lib/config";
import {
  BASE_CHAIN_ID,
  BASE_CHAIN_ID_HEX,
  EXPIRY_30_DAYS_SEC,
  ensureBaseChain,
  isUserRejected,
  isUnsupportedWallet,
  getMetaMaskSmartAccount,
  createAquaDelegation,
  persistDelegation,
  revokeDelegation,
} from "@/lib/mm/delegation";

export type MmDelegationStatus = "unknown" | "not-delegated" | "delegated" | "checking";

export function useMmDelegation() {
  const { address, chainId: walletChainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [status, setStatus] = useState<MmDelegationStatus>("unknown");
  const [agentAddress, setAgentAddress] = useState<Address | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delegation, setDelegation] = useState<any | null>(null);

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

  const checkDelegation = useCallback(async () => {
    if (!address) return;
    setStatus("checking");
    try {
      const API = typeof window !== "undefined" && window.location.hostname !== "localhost" ? "/backend" : "http://localhost:3001";
      const res = await fetch(`${API}/api/delegations?delegator=${address}`);
      if (!res.ok) {
        setStatus("not-delegated");
        return;
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.delegations ?? [];
      if (list.length > 0) {
        const active = list.find((d: any) => {
          if (!d.expiresAt) return true;
          return new Date(d.expiresAt).getTime() > Date.now();
        });
        if (active) {
          setDelegation(active.delegationJson ?? active);
          setStatus("delegated");
          return;
        }
      }
      setStatus("not-delegated");
    } catch {
      setStatus("not-delegated");
    }
  }, [address]);

  useEffect(() => {
    checkDelegation();
  }, [checkDelegation]);

  const ensure7702 = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient) {
      setError("Wallet not connected");
      return false;
    }
    if (!walletClient) {
      setError("Wallet not connected — please connect your wallet first");
      return false;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      if (walletChainId !== undefined && walletChainId !== BASE_CHAIN_ID) {
        await ensureBaseChain();
      } else {
        try {
          await ensureBaseChain();
        } catch (e: any) {
          if (e?.message?.includes("rejected") || e?.message?.includes("Base")) throw e;
        }
      }
      const { smartAccount } = await getMetaMaskSmartAccount({
        client: publicClient,
        address,
        walletClient,
      });
      const isDeployed = await publicClient.getCode({ address });
      if (isDeployed && isDeployed !== "0x" && isDeployed.length > 4) {
        return true;
      }
      void smartAccount;
      return true;
    } catch (err: any) {
      if (isUserRejected(err)) {
        setError("Authorization rejected — please approve to activate smart wallet.");
      } else if (isUnsupportedWallet(err)) {
        setError(
          "Your wallet doesn't support EIP-7702 delegation. Please update MetaMask to latest version or use a wallet that supports EIP-7702."
        );
      } else if (err?.message?.includes("Base")) {
        setError(err.message);
      } else {
        setError(err?.shortMessage || err?.message || "Failed to enable 7702 smart account");
      }
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [address, publicClient, walletClient, walletChainId]);

  const grantDelegation = useCallback(async (): Promise<boolean> => {
    if (!address || !publicClient || !agentAddress) {
      setError("Wallet not connected or agent not loaded");
      return false;
    }
    if (!walletClient) {
      setError("Wallet not connected — please connect your wallet first");
      return false;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await ensureBaseChain();
      const { delegation: signedDelegation, expiry } = await createAquaDelegation({
        client: publicClient,
        delegator: address,
        delegate: agentAddress,
        walletClient,
        expirySeconds: EXPIRY_30_DAYS_SEC,
      });
      const expiresAt = new Date(expiry * 1000).toISOString();
      await persistDelegation({
        delegator: address,
        delegate: agentAddress,
        delegation: signedDelegation,
        chainId: BASE_CHAIN_ID,
        expiresAt,
      });
      setDelegation(signedDelegation);
      setStatus("delegated");
      return true;
    } catch (err: any) {
      if (isUserRejected(err)) {
        setError("Signature rejected — please approve the delegation to continue.");
      } else if (isUnsupportedWallet(err)) {
        setError(
          "Your wallet doesn't support delegation. Please update MetaMask or use a compatible wallet."
        );
      } else if (err?.code === 4001) {
        setError("Request rejected — please approve the signature to delegate.");
      } else if (err?.message?.toLowerCase().includes("unsupported")) {
        setError("Your wallet does not support this operation. Please use MetaMask latest version.");
      } else {
        setError(err?.shortMessage || err?.message || "Failed to create delegation");
      }
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [address, publicClient, walletClient, agentAddress]);

  const revoke = useCallback(async (): Promise<boolean> => {
    if (!address) {
      setError("Wallet not connected");
      return false;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await revokeDelegation({ delegator: address, delegate: agentAddress ?? undefined });
      setDelegation(null);
      setStatus("not-delegated");
      return true;
    } catch (err: any) {
      setError(err?.message || "Failed to revoke delegation");
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [address, agentAddress]);

  return {
    status,
    agentAddress,
    delegation,
    isSubmitting,
    error,
    ensure7702,
    grantDelegation,
    revoke,
    checkDelegation,
    chainId: BASE_CHAIN_ID,
    chainIdHex: BASE_CHAIN_ID_HEX,
  };
}
