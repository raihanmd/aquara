"use client";

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  Implementation,
  toMetaMaskSmartAccount,
  createDelegation,
  getSmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { AQUA, SELECTORS, KNOWN_TOKENS } from "@/lib/config";

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_ID_HEX = "0x2105" as const;
export const EXPIRY_30_DAYS_SEC = 30 * 24 * 60 * 60;

export const BASE_ADD_PARAMS = {
  chainId: BASE_CHAIN_ID_HEX,
  chainName: "Base",
  rpcUrls: ["https://mainnet.base.org"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  blockExplorerUrls: ["https://basescan.org"],
} as const;

export async function ensureBaseChain(): Promise<void> {
  const provider = (window as any).ethereum;
  if (!provider) throw new Error("No wallet provider found. Please install MetaMask.");

  let currentChainId: number | null = null;
  try {
    const hex = await provider.request({ method: "eth_chainId" });
    currentChainId = parseInt(hex as string, 16);
  } catch {}

  if (currentChainId === BASE_CHAIN_ID) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (switchErr: any) {
    if (switchErr?.code === 4902) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [BASE_ADD_PARAMS],
        });
      } catch (addErr: any) {
        if (addErr?.code === 4001) {
          throw new Error("Please add Base (8453) to your wallet to continue.");
        }
        throw new Error(
          addErr?.message ||
            "Failed to add Base. Please add it manually: chainId 8453, RPC https://mainnet.base.org"
        );
      }
    } else if (switchErr?.code === 4001) {
      throw new Error("Chain switch rejected - please switch to Base (8453) to continue.");
    } else if (
      switchErr?.code === -32603 ||
      switchErr?.message?.toLowerCase().includes("unsupported")
    ) {
      throw new Error(
        "Your wallet does not support switching chains. Please manually switch to Base (8453)."
      );
    } else {
      throw new Error(switchErr?.message || "Failed to switch to Base (8453). Please switch manually.");
    }
  }

  try {
    const hexAfter = await provider.request({ method: "eth_chainId" });
    const afterId = parseInt(hexAfter as string, 16);
    if (afterId !== BASE_CHAIN_ID) {
      throw new Error(`Wallet is on chain ${afterId}, expected Base (8453). Please switch manually.`);
    }
  } catch (e: any) {
    if (e?.message?.includes("expected Base")) throw e;
  }
}

export function isUserRejected(err: any): boolean {
  const code = err?.code;
  const msg = (err?.message || err?.shortMessage || "").toLowerCase();
  return code === 4001 || msg.includes("rejected") || msg.includes("denied") || msg.includes("user rejected");
}

export function isUnsupportedWallet(err: any): boolean {
  const msg = (err?.message || err?.shortMessage || "").toLowerCase();
  const code = err?.code;
  return (
    msg.includes("not supported") ||
    msg.includes("not support") ||
    msg.includes("method not found") ||
    msg.includes("unsupported") ||
    msg.includes("does not support") ||
    code === -32601 ||
    code === -32602
  );
}

export async function getMetaMaskSmartAccount(params: {
  client: PublicClient;
  address: Address;
  walletClient?: WalletClient;
}) {
  const { client, address, walletClient } = params;
  const environment = getSmartAccountsEnvironment(BASE_CHAIN_ID);
  const smartAccount = await toMetaMaskSmartAccount({
    client: client as any,
    implementation: Implementation.Stateless7702,
    address,
    ...(walletClient ? { signer: { walletClient: walletClient as any } } : {}),
    environment,
  });
  return { smartAccount, environment };
}

export interface CreateAquaDelegationParams {
  client: PublicClient;
  delegator: Address;
  delegate: Address;
  walletClient?: WalletClient;
  expirySeconds?: number;
  extraTokens?: Address[];
}

export async function createAquaDelegation(params: CreateAquaDelegationParams) {
  const {
    client,
    delegator,
    delegate,
    walletClient,
    expirySeconds = EXPIRY_30_DAYS_SEC,
    extraTokens = [],
  } = params;

  const environment = getSmartAccountsEnvironment(BASE_CHAIN_ID);
  const nowSec = Math.floor(Date.now() / 1000);
  const expirySec = nowSec + expirySeconds;
  const approveTargets = [...KNOWN_TOKENS, ...extraTokens];
  const allTargets = [AQUA, ...approveTargets];
  const caveatBuilder = createCaveatBuilder(environment);
  caveatBuilder.addCaveat("allowedTargets", { targets: allTargets });
  caveatBuilder.addCaveat("allowedMethods", {
    selectors: [SELECTORS.aquaShip, SELECTORS.aquaDock, SELECTORS.erc20Approve],
  });
  caveatBuilder.addCaveat("timestamp", {
    afterThreshold: nowSec,
    beforeThreshold: expirySec,
  });
  const caveats = caveatBuilder.build();
  const delegation = createDelegation({
    environment,
    from: delegator,
    to: delegate,
    caveats,
    scope: {
      type: "functionCall",
      targets: allTargets,
      selectors: [SELECTORS.aquaShip, SELECTORS.aquaDock, SELECTORS.erc20Approve],
    },
  } as unknown as Parameters<typeof createDelegation>[0]);
  let signedDelegation = delegation;
  if (walletClient) {
    const { smartAccount } = await getMetaMaskSmartAccount({
      client,
      address: delegator,
      walletClient,
    });
    const signature = await (smartAccount as any).signDelegation({
      delegation,
      chainId: BASE_CHAIN_ID,
    });
    signedDelegation = { ...delegation, signature };
  }
  return {
    delegation: signedDelegation,
    environment,
    expiry: expirySec,
    caveats,
  };
}

export interface RedeemParams {
  delegation: any;
  executions: { target: Address; value?: bigint; callData?: Hex }[];
}

export function buildRedeemExecutions(params: {
  target?: Address;
  callData?: Hex;
  value?: bigint;
}) {
  const { target = AQUA, callData = "0x" as Hex, value = 0n } = params;
  return [{ target, callData, value }];
}

export async function redeemDelegation(params: {
  client: PublicClient;
  walletClient: WalletClient;
  delegation: any;
  executions: { target: Address; value?: bigint; callData?: Hex }[];
}) {
  const { client, walletClient, delegation, executions } = params;
  const environment = getSmartAccountsEnvironment(BASE_CHAIN_ID);
  const delegator = delegation.delegator as Address;
  const { smartAccount } = await getMetaMaskSmartAccount({
    client,
    address: delegator,
    walletClient,
  });
  return {
    smartAccount,
    environment,
    delegation,
    executions,
  };
}

export async function persistDelegation(params: {
  delegator: Address;
  delegate: Address;
  delegation: any;
  chainId?: number;
  expiresAt?: string;
}) {
  const { delegator, delegate, delegation, chainId = BASE_CHAIN_ID, expiresAt } = params;
  const res = await fetch(`/api/delegations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      delegator,
      delegate,
      chainId,
      delegationJson: delegation,
      caveats: delegation.caveats ?? null,
      expiresAt: expiresAt ?? new Date(Date.now() + EXPIRY_30_DAYS_SEC * 1000).toISOString(),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `Failed to persist delegation: ${res.status}`);
  }
  return res.json();
}

export async function revokeDelegation(params: { delegator: Address; delegate?: Address }) {
  const { delegator, delegate } = params;
  const url = delegate
    ? `/api/delegations?delegator=${delegator}&delegate=${delegate}`
    : `/api/delegations?delegator=${delegator}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `Failed to revoke delegation: ${res.status}`);
  }
  return res.json();
}
