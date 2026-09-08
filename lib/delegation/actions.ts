/**
 * Delegation Actions - builds the calldata for the delegation transaction.
 *
 * Single-tx flow:
 *   authorizationList: [Calibur 7702 delegation]
 *   to: userEOA (self-call)
 *   data: execute(BatchedCall) containing:
 *     1. register(agentKey) → self-call
 *     2. setCanExecute() × N → calls to hook contract
 *     3. update(keyHash, {expiry, hook}) → self-call
 */

import {
  type Address,
  type Hex,
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
} from "viem";
import {
  caliburAbi,
  caliburUpdateAbi,
  eip712DomainAbi,
  hookAbi,
  ANY_FN_SEL,
  ANY_TARGET,
  CALIBUR_ADDRESS,
  GUARDED_EXECUTOR_HOOK,
  ONEINCH_V6_ROUTER,
} from "./constants";
import { AQUA, KNOWN_TOKENS, SELECTORS } from "@/lib/config";

// ── Compute key hash (matches agent-service/src/lib/calibur.ts) ──────────

export function computeKeyHash(agentAddress: Address): Hex {
  const SECP256K1_KEY_TYPE = 2;
  const publicKeyEncoded = encodeAbiParameters(
    [{ type: "address" }],
    [agentAddress]
  );
  const innerHash = keccak256(publicKeyEncoded);
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }],
      [SECP256K1_KEY_TYPE, innerHash]
    )
  );
}

// ── Build the combined delegation calldata ────────────────────────────────

interface DelegationParams {
  userAddress: Address;
  agentAddress: Address;
  /** Expiry in seconds from now (default: 30 days) */
  expirySeconds?: number;
  /** Extra token addresses to whitelist for approve() */
  extraTokens?: Address[];
}

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/**
 * Build the calldata for a single execute(BatchedCall) transaction
 * that registers the agent key, configures hook whitelist, and sets hook settings.
 */
export function buildDelegationCalldata(params: DelegationParams): Hex {
  const {
    userAddress,
    agentAddress,
    expirySeconds = 30 * 24 * 60 * 60,
    extraTokens = [],
  } = params;

  const keyHash = computeKeyHash(agentAddress);
  const calls: Call[] = [];

  // 1. Register agent key (self-call to user's Calibur-delegated EOA)
  const SECP256K1 = 2;
  const publicKeyEncoded = encodeAbiParameters(
    [{ type: "address" }],
    [agentAddress]
  );
  const registerData = encodeFunctionData({
    abi: caliburAbi,
    functionName: "register",
    args: [{ keyType: SECP256K1, publicKey: publicKeyEncoded }],
  });
  calls.push({ to: userAddress, value: 0n, data: registerData });

  // 2. Configure hook whitelist (calls to hook contract)
  const whitelistEntries: { target: Address; selector: Hex }[] = [
    { target: AQUA, selector: SELECTORS.aquaShip },
    { target: AQUA, selector: SELECTORS.aquaDock },
    // 1inch router, any entry point (agent swaps need this)
    { target: ONEINCH_V6_ROUTER, selector: ANY_FN_SEL },
    // approve() on any token (agent must approve whatever strategies need)
    { target: ANY_TARGET, selector: SELECTORS.erc20Approve },
    // Token approvals
    ...KNOWN_TOKENS.concat(extraTokens).map((token) => ({
      target: token,
      selector: SELECTORS.erc20Approve,
    })),
  ];

  for (const entry of whitelistEntries) {
    const setCanExecuteData = encodeFunctionData({
      abi: hookAbi,
      functionName: "setCanExecute",
      args: [keyHash, entry.target, entry.selector as `0x${string}`, true],
    });
    calls.push({
      to: GUARDED_EXECUTOR_HOOK,
      value: 0n,
      data: setCanExecuteData,
    });
  }

  // 3. Update key settings to point to hook (self-call via BatchedCall)
  // Settings is a packed uint256: (expiry << 160) | hookAddress
  const expiry = BigInt(Math.floor(Date.now() / 1000) + expirySeconds);
  const packedSettings = (expiry << 160n) | BigInt(GUARDED_EXECUTOR_HOOK);
  const updateData = encodeFunctionData({
    abi: caliburUpdateAbi,
    functionName: "update",
    args: [keyHash, packedSettings],
  });
  calls.push({ to: userAddress, value: 0n, data: updateData });

  // Wrap all calls in execute(BatchedCall)
  const batchCalldata = encodeFunctionData({
    abi: caliburAbi,
    functionName: "execute",
    args: [{ calls, revertOnFailure: true }],
  });

  return batchCalldata;
}

/**
 * Build the raw individual calls for wallet_sendCalls (EIP-5792).
 * Returns the calls array WITHOUT wrapping in execute(BatchedCall).
 * The wallet handles batching/routing internally.
 */
export function buildDelegationCalls(params: DelegationParams): Call[] {
  const {
    userAddress,
    agentAddress,
    expirySeconds = 30 * 24 * 60 * 60,
    extraTokens = [],
  } = params;

  const keyHash = computeKeyHash(agentAddress);
  const calls: Call[] = [];

  // 1. Register agent key (self-call)
  const SECP256K1 = 2;
  const publicKeyEncoded = encodeAbiParameters(
    [{ type: "address" }],
    [agentAddress]
  );
  const registerData = encodeFunctionData({
    abi: caliburAbi,
    functionName: "register",
    args: [{ keyType: SECP256K1, publicKey: publicKeyEncoded }],
  });
  calls.push({ to: userAddress, value: 0n, data: registerData });

  // 2. Configure GuardedExecutorHook whitelist
  // Only allows the agent to call specific selectors on specific targets
  const whitelistEntries: { target: Address; selector: Hex }[] = [
    { target: AQUA, selector: SELECTORS.aquaShip },
    { target: AQUA, selector: SELECTORS.aquaDock },
    // 1inch router, any entry point (agent swaps need this)
    { target: ONEINCH_V6_ROUTER, selector: ANY_FN_SEL },
    // approve() on any token (agent must approve whatever strategies need)
    { target: ANY_TARGET, selector: SELECTORS.erc20Approve },
    ...KNOWN_TOKENS.concat(extraTokens).map((token) => ({
      target: token,
      selector: SELECTORS.erc20Approve,
    })),
  ];

  for (const entry of whitelistEntries) {
    const setCanExecuteData = encodeFunctionData({
      abi: hookAbi,
      functionName: "setCanExecute",
      args: [keyHash, entry.target, entry.selector as `0x${string}`, true],
    });
    calls.push({
      to: GUARDED_EXECUTOR_HOOK,
      value: 0n,
      data: setCanExecuteData,
    });
  }

  // 3. Update key settings (self-call) - set expiry + hook
  // Settings is packed uint256: (expiry << 160) | hookAddress
  const expiry = BigInt(Math.floor(Date.now() / 1000) + expirySeconds);
  const packedSettings = (expiry << 160n) | BigInt(GUARDED_EXECUTOR_HOOK);
  const updateData = encodeFunctionData({
    abi: caliburUpdateAbi,
    functionName: "update",
    args: [keyHash, packedSettings],
  });
  calls.push({ to: userAddress, value: 0n, data: updateData });

  return calls;
}

/**
 * Simpler 2-tx flow if one-tx doesn't work:
 * TX1: register(agentKey)
 * TX2: execute(BatchedCall) with [setCanExecute × N, update]
 */
export function buildRegisterCalldata(agentAddress: Address): Hex {
  const SECP256K1 = 2;
  const publicKeyEncoded = encodeAbiParameters(
    [{ type: "address" }],
    [agentAddress]
  );
  return encodeFunctionData({
    abi: caliburAbi,
    functionName: "register",
    args: [{ keyType: SECP256K1, publicKey: publicKeyEncoded }],
  });
}

export function buildHookSetupCalldata(params: {
  userAddress: Address;
  agentAddress: Address;
  expirySeconds?: number;
  extraTokens?: Address[];
}): Hex {
  const {
    userAddress,
    agentAddress,
    expirySeconds = 30 * 24 * 60 * 60,
    extraTokens = [],
  } = params;

  const keyHash = computeKeyHash(agentAddress);
  const calls: Call[] = [];

  // Hook whitelist entries
  const whitelistEntries: { target: Address; selector: Hex }[] = [
    { target: AQUA, selector: SELECTORS.aquaShip },
    { target: AQUA, selector: SELECTORS.aquaDock },
    ...KNOWN_TOKENS.concat(extraTokens).map((token) => ({
      target: token,
      selector: SELECTORS.erc20Approve,
    })),
  ];

  for (const entry of whitelistEntries) {
    const data = encodeFunctionData({
      abi: hookAbi,
      functionName: "setCanExecute",
      args: [keyHash, entry.target, entry.selector as `0x${string}`, true],
    });
    calls.push({ to: GUARDED_EXECUTOR_HOOK, value: 0n, data });
  }

  // Update key settings - packed uint256: (expiry << 160) | hookAddress
  const expiry = BigInt(Math.floor(Date.now() / 1000) + expirySeconds);
  const packedSettings = (expiry << 160n) | BigInt(GUARDED_EXECUTOR_HOOK);
  const updateData = encodeFunctionData({
    abi: caliburUpdateAbi,
    functionName: "update",
    args: [keyHash, packedSettings],
  });
  calls.push({ to: userAddress, value: 0n, data: updateData });

  return encodeFunctionData({
    abi: caliburAbi,
    functionName: "execute",
    args: [{ calls, revertOnFailure: true }],
  });
}

export function buildRevokeCall(userAddress: Address, keyHash: Hex): Call {
  const data = encodeFunctionData({
    abi: caliburAbi,
    functionName: "revoke",
    args: [keyHash],
  });
  return { to: userAddress, value: 0n, data };
}

// ── Version-agnostic Calibur support ─────────────────────────────────────
// Works with ANY Calibur implementation (v1.0.0, v1.1.0, future): parse the
// 7702 target from code, confirm the Calibur key-management interface with a
// static call, and read the exact EIP-712 domain on-chain (EIP-5267) so
// signatures always match the deployed implementation.

export function parse7702Target(code: string | undefined | null): Address | null {
  if (!code) return null;
  const lower = code.toLowerCase();
  if (!lower.startsWith("0xef0100") || lower.length < 48) return null;
  return ("0x" + lower.slice(8, 48)) as Address;
}

export function caliburSaltFor(impl: Address): Hex {
  return ("0x000000000000000000000000" + impl.toLowerCase().slice(2)) as Hex;
}

const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

const isRegisteredProbeAbi = [
  {
    name: "isRegistered",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface ChainReader {
  getCode: (args: { address: Address }) => Promise<string | undefined>;
  readContract: (args: any) => Promise<any>;
}

export async function verifyCaliburAccount(
  client: ChainReader,
  account: Address
): Promise<Address | null> {
  const code = await client.getCode({ address: account });
  const impl = parse7702Target(code);
  if (!impl) return null;
  try {
    const result = await client.readContract({
      address: account,
      abi: isRegisteredProbeAbi,
      functionName: "isRegistered",
      args: [ZERO_HASH],
    });
    if (typeof result !== "boolean") return null;
    return impl;
  } catch {
    return null;
  }
}

export interface CaliburDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
  salt: Hex;
}

export async function readCaliburDomain(
  client: ChainReader,
  account: Address,
  impl: Address
): Promise<CaliburDomain> {
  try {
    const [, name, version, chainId, verifyingContract, salt] =
      (await client.readContract({
        address: account,
        abi: eip712DomainAbi,
        functionName: "eip712Domain",
        args: [],
      })) as unknown as readonly [string, string, string, bigint, Address, Hex];
    if (name && version && salt) {
      return {
        name,
        version,
        chainId: Number(chainId),
        verifyingContract,
        salt,
      };
    }
  } catch {
    // ignored - static fallback below covers non-EIP-5267 implementations
  }
  return {
    name: "Calibur",
    version: "1.0.0",
    chainId: 8453,
    verifyingContract: account,
    salt: caliburSaltFor(impl),
  };
}
