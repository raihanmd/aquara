import { type Address, type Hex, keccak256, toBytes } from "viem";

// ── Contract Addresses (Base Mainnet) ─────────────────────────────────────
export const CALIBUR_ADDRESS: Address =
  "0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00";

// TODO: deploy AquaHook for ship/dock, then replace. Reuse ALMA hook for now.
export const GUARDED_EXECUTOR_HOOK: Address =
  "0x033Be604929CbD65Fb67880741aB2b8292E46dC8";

// Aqua (1inch) - same on 13 chains
export const AQUA: Address = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";
export const AQUA_ROUTER: Address =
  "0x111111338c5091e8440b67b168bae16a668ac0de";

// Legacy Uniswap (keep for reference, not used for Aqua)
export const POSITION_MANAGER: Address =
  "0x7c5f5a4bbd8fd63184577525326123b519429bdc";
export const UNIVERSAL_ROUTER: Address =
  "0x6ff5693b99212da76ad316178a184ab56d299b43";
export const PERMIT2: Address =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Known tokens on Base to whitelist for approve() -> Aqua
export const KNOWN_TOKENS: Address[] = [
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0x4200000000000000000000000000000000000006", // WETH
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
];

export const API_URL = "";

export const SELECTORS = {
  aquaShip: "0xf50b870f" as Hex,
  aquaDock: "0x28defc17" as Hex,
  modifyLiquidities: keccak256(
    toBytes("modifyLiquidities(bytes,uint256)")
  ).slice(0, 10) as Hex,
  universalRouterExecute: keccak256(
    toBytes("execute(bytes,bytes[],uint256)")
  ).slice(0, 10) as Hex,
  permit2Approve: keccak256(
    toBytes("approve(address,address,uint160,uint48)")
  ).slice(0, 10) as Hex,
  erc20Approve: "0x095ea7b3" as Hex,
};

// ── Calibur ABI (subset for frontend) ───��─────────────────────────────────

const CallComponents = [
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
] as const;

const BatchedCallComponents = [
  { name: "calls", type: "tuple[]", components: CallComponents },
  { name: "revertOnFailure", type: "bool" },
] as const;

// SignedBatchedCall components for ABI encoding
const SignedBatchedCallComponents = [
  { name: "batchedCall", type: "tuple", components: BatchedCallComponents },
  { name: "nonce", type: "uint256" },
  { name: "keyHash", type: "bytes32" },
  { name: "executor", type: "address" },
  { name: "deadline", type: "uint256" },
] as const;

export const caliburAbi = [
  // Execute (direct, by owner)
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "batchedCall",
        type: "tuple",
        components: BatchedCallComponents,
      },
    ],
    outputs: [],
  },
  // Execute (signature-based, via relayer)
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "signedBatchedCall",
        type: "tuple",
        components: SignedBatchedCallComponents,
      },
      { name: "wrappedSignature", type: "bytes" },
    ],
    outputs: [],
  },
  // Key management
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "keyType", type: "uint8" },
          { name: "publicKey", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "keyHash", type: "bytes32" }],
  },
  {
    name: "isRegistered",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "getSeq",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "revoke",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [],
  },
] as const;

// ── GuardedExecutorHook ABI ───────────��───────────────────────────────────
export const hookAbi = [
  {
    name: "setCanExecute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
] as const;

// ── Calibur update() ABI (for setting hook on key) ──────────────────────
// Settings is `type Settings is uint256` in Solidity - a packed uint256, NOT a struct.
// Layout: bits 0-159 = hook address, bits 160-199 = expiry (uint40), bit 200 = isAdmin
// Pack as: (expiry << 160n) | BigInt(hookAddress)
export const caliburUpdateAbi = [
  {
    name: "update",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "settings", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
