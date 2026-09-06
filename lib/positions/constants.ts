// Base Mainnet — Uniswap V4
export const POSITION_MANAGER = "0x7c5f5a4bbd8fd63184577525326123b519429bdc" as const;
export const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71" as const;
export const CHAIN_ID = 8453; // Base

export const POSITION_MANAGER_ABI = [
  {
    name: "getPoolAndPositionInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "info", type: "uint256" },
    ],
  },
  {
    name: "getPositionLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

export const STATE_VIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    name: "getLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

export const TOKEN_SYMBOLS: Record<string, string> = {
  // Sepolia
  "0x0000000000000000000000000000000000000000": "ETH",
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": "WETH",
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": "USDC",
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0x820c137fa70c8691f0e44dc420a5e53c168921dc": "USDS",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "0x4200000000000000000000000000000000000006": "WETH",
  "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": "VIRTUAL",
  "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452": "wstETH",
};

export const QUIRKY_MESSAGES = [
  "Watching your positions...",
  "Markets never sleep, neither do I.",
  "Your liquidity, optimized.",
  "Keeping your ranges tight.",
  "Fees are accumulating nicely.",
  "All systems operational.",
];

