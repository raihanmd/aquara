import { type Address, type Hex } from "viem";

export const AQUA: Address = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";
export const AQUA_ROUTER: Address =
  "0x111111338c5091e8440b67b168bae16a668ac0de";

export const KNOWN_TOKENS: Address[] = [
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "0x4200000000000000000000000000000000000006",
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
];

export const API_URL =
  typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? "/backend"
    : "http://localhost:3001";

export const SELECTORS = {
  aquaShip: "0xf50b870f" as Hex,
  aquaDock: "0x28defc17" as Hex,
  erc20Approve: "0x095ea7b3" as Hex,
};

export const QUIRKY_MESSAGES = [
  "Watching your positions...",
  "Markets never sleep, neither do I.",
  "Your liquidity, optimized.",
  "Keeping your ranges tight.",
  "Fees are accumulating nicely.",
  "All systems operational.",
];
