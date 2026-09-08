import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { BotConfig } from "./config.js";
import { logTick } from "./log.js";
import { simulateTx } from "./precheck.js";

const ROUTER = "0x111111338c5091e8440b67b168bae16a668ac0de" as Address;

const ERC20_MIN = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const AQUA_REGISTRY = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a" as Address;

const AQUA_MIN = [
  {
    name: "rawBalances",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "balance", type: "uint248" }, { name: "tokensCount", type: "uint8" }],
  },
] as const;

export interface FillInput {
  strategyHash: string;
  tokenA: string;
  tokenB: string;
  tokenIn: string;
  amountRaw: string;
  mode: string | null;
  sizeUsd: number;
  taker?: string;
  exactOut?: boolean;
}

export interface FillResult {
  decision: "fill" | "skip" | "blocked";
  reason: string;
  quotedOut?: string;
  txHash?: string;
  gasUsed?: string;
}

export async function executeFill(cfg: BotConfig, input: FillInput): Promise<FillResult> {
  const startedAt = new Date().toISOString();
  const pair = `${input.tokenA}/${input.tokenB}`;
  const done = (r: FillResult) => {
    logTick({
      at: startedAt,
      pair,
      decision: r.decision === "fill" ? "fill" : r.decision === "skip" ? "skip" : "blocked",
      reason: r.reason,
      sizeUsd: input.sizeUsd,
      quotedOut: r.quotedOut,
      txHash: r.txHash,
      gasUsed: r.gasUsed,
      dryRun: cfg.dryRun,
    });
    return r;
  };

  const maxDrain = input.amountRaw.toLowerCase() === "max";
  let amountValid = maxDrain;
  if (!maxDrain) {
    try {
      amountValid = BigInt(input.amountRaw) > 0n;
    } catch {
      amountValid = false;
    }
  }
  if (!input.strategyHash || !input.tokenIn || !input.amountRaw || !amountValid) {
    return done({ decision: "skip", reason: "missing tokenIn/amountRaw for fill" });
  }
  const tokenIn = input.tokenIn as Address;
  const wantsMax = input.amountRaw.toLowerCase() === "max";
  const exactOut = input.exactOut === true || wantsMax;
  const amountIn = !exactOut ? BigInt(input.amountRaw) : 0n;
  const taker = (input.taker ?? cfg.taker ?? cfg.maker) as Address;

  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain: base, transport });

  if (!exactOut) {
  const takerAllowance = (await publicClient
    .readContract({
      address: tokenIn,
      abi: ERC20_MIN,
      functionName: "allowance",
      args: [taker, ROUTER],
    })
    .catch(() => 0n)) as bigint;
  if (takerAllowance < amountIn) {
    if (cfg.dryRun || !cfg.takerKey) {
      return done({
        decision: "blocked",
        reason: `taker allowance ${takerAllowance} < ${amountIn} - approve ROUTER ${ROUTER.slice(0, 10)}… first`,
      });
    }
    const takerAccount = privateKeyToAccount(cfg.takerKey);
    const takerWallet = createWalletClient({ account: takerAccount, chain: base, transport });
    const approveHash = await takerWallet.sendTransaction({
      to: tokenIn,
      data: encodeFunctionData({ abi: ERC20_MIN, functionName: "approve", args: [ROUTER, amountIn] }),
      value: 0n,
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }
  }

  const vmSdk = await import("@1inch/swap-vm-sdk");
  const aquaSdk = await import("@1inch/aqua-sdk");
  const sbc = new (vmSdk.SwapVMContract as any)(new (aquaSdk.Address as any)(ROUTER));

  const apiKey = process.env.BOT_1INCH_KEY || "";
  let order: any;
  try {
    const ov = await fetch(
      `https://api.1inch.com/aqua/v1.0/strategies/overview/8453/${cfg.maker}/${ROUTER}/${input.strategyHash}`,
      apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {},
    );
    if (!ov.ok) return done({ decision: "skip", reason: `strategy lookup failed (${ov.status})` });
    const match = await ov.json();
    const state = match?.classification?.state ?? match?.status ?? "unknown";
    if (state === "closed" || state === "docked" || match?.closedAt) {
      return done({ decision: "skip", reason: `strategy is ${state} - nothing to fill` });
    }
    if (!match?.strategyBytes)
      return done({ decision: "skip", reason: "strategy bytes not found for hash" });
    const { HexString } = await import("@1inch/sdk-core");
    order = (vmSdk.Order as any).decode(new HexString(match.strategyBytes));
    if (!input.tokenA || !input.tokenB) {
      const addrs = ((match.tokens ?? []) as any[])
        .map((t: any) => String(t?.address ?? ""))
        .filter(Boolean);
      const other = addrs.find((a: string) => a.toLowerCase() !== tokenIn.toLowerCase());
      const same = addrs.find((a: string) => a.toLowerCase() === tokenIn.toLowerCase());
      if (other) {
        input.tokenA = same ?? tokenIn;
        input.tokenB = other;
      }
    }
  } catch (e: any) {
    return done({ decision: "skip", reason: `strategy decode failed (${e?.message ?? e})` });
  }
  const tokenOut = (input.tokenIn.toLowerCase() === (input.tokenA || "").toLowerCase()
    ? input.tokenB
    : input.tokenA) as Address;
  if (!tokenOut) {
    return done({ decision: "skip", reason: "cannot resolve tokenOut for pair" });
  }
  const baseTraits = (vmSdk.TakerTraits as any).default();
  const takerTraits = exactOut ? baseTraits.with({ exactIn: false }) : baseTraits;

  let amountForQuote: bigint;
  if (exactOut && wantsMax) {
    try {
      const rb = (await publicClient.readContract({
        address: AQUA_REGISTRY,
        abi: AQUA_MIN,
        functionName: "rawBalances",
        args: [cfg.maker as Address, ROUTER, input.strategyHash as Hex, tokenOut],
      })) as unknown as readonly [bigint, number];
      const bal = Array.isArray(rb) ? (rb[0] as bigint) : 0n;
      if (bal <= 0n) {
        return done({ decision: "skip", reason: "drain target empty - side depleted" });
      }
      amountForQuote = bal;
    } catch {
      return done({ decision: "skip", reason: "drain balance read failed" });
    }
  } else {
    amountForQuote = exactOut ? BigInt(input.amountRaw) : amountIn;
  }

  const quoteCall = sbc.quote({
    order,
    tokenIn: new (vmSdk.Address as any)(tokenIn),
    tokenOut: new (vmSdk.Address as any)(tokenOut),
    amount: amountForQuote,
    takerTraits,
  });
  const quoteTx = { to: ROUTER, data: quoteCall.data.toString() as Hex, value: 0n, from: taker };

  const sim = await simulateTx(publicClient as any, quoteTx);
  if (!sim.ok) {
    return done({ decision: "skip", reason: sim.reason });
  }

  let quotedOut = 0n;
  let quotedIn = 0n;
  try {
    const res = (await publicClient.call({ ...quoteTx, account: taker })) as unknown as { data?: Hex };
    if (res?.data && res.data.length >= 194) {
      const { decodeAbiParameters } = await import("viem");
      const [amountInQ, amountOutQ] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        res.data as Hex,
      ) as unknown as [bigint, bigint, Hex];
      quotedIn = amountInQ;
      quotedOut = amountOutQ;
    } else {
      return done({ decision: "skip", reason: "quote returned malformed data" });
    }
  } catch {
    return done({ decision: "skip", reason: "quote reverted - spot likely outside range or side depleted" });
  }
  if (quotedOut <= 0n) {
    return done({ decision: "skip", reason: "quote returned zero out - no fillable liquidity" });
  }

  const gasPrice = await publicClient.getGasPrice().catch(() => 0n);
  const gasCostWei = (sim.gasEstimate ?? 300000n) * gasPrice;
  if (process.env.BOT_SKIP_ECON !== "true") {
    const feeBps = Number(process.env.BOT_FEE_BPS || 10);
    let ethUsd = 3000;
    try {
      const pr = await fetch(
        `https://api.1inch.com/price/v1.1/8453/0x4200000000000000000000000000000000000006?currency=USD`,
        apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {},
      );
      if (pr.ok) {
        const pj = await pr.json();
        const v = Number(pj["0x4200000000000000000000000000000000000006"] ?? 0);
        if (v > 0) ethUsd = v;
      }
    } catch {}
    const gasUsd = (Number(gasCostWei) / 1e18) * ethUsd;
    const feeUsd = input.sizeUsd * (feeBps / 10000);
    if (gasUsd > feeUsd) {
      return done({
        decision: "skip",
        reason: `gas $${gasUsd.toFixed(4)} over expected fee $${feeUsd.toFixed(4)} - tick too small or Bypass with BOT_SKIP_ECON=true`,
        quotedOut: quotedOut.toString(),
      });
    }
  } else {
    logTick({
      at: startedAt, pair: `${input.tokenA}/${input.tokenB}`, decision: "blocked",
      reason: "econ check bypassed (BOT_SKIP_ECON)",
      sizeUsd: input.sizeUsd, quotedOut: quotedOut.toString(), dryRun: cfg.dryRun,
    });
  }

  if (cfg.dryRun || !cfg.takerKey) {
    return done({
      decision: "blocked",
      reason: cfg.takerKey ? "dry-run: would submit swap" : "no taker key configured",
      quotedOut: quotedOut.toString(),
    });
  }

  const account = privateKeyToAccount(cfg.takerKey);
  const walletClient = createWalletClient({ account, chain: base, transport });

  let submitTraits = takerTraits;
  if (exactOut) {
    const threshold = (quotedIn * 1005n) / 1000n;
    submitTraits = baseTraits.with({ exactIn: false, threshold });
    const allowNow = (await publicClient
      .readContract({
        address: tokenIn,
        abi: ERC20_MIN,
        functionName: "allowance",
        args: [account.address, ROUTER],
      })
      .catch(() => 0n)) as bigint;
    if (allowNow < threshold) {
      const approveHash = await walletClient.sendTransaction({
        to: tokenIn,
        data: encodeFunctionData({ abi: ERC20_MIN, functionName: "approve", args: [ROUTER, threshold] }),
        value: 0n,
        chain: base,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }

  const swapCall = sbc.swap({
    order,
    tokenIn: new (vmSdk.Address as any)(tokenIn),
    tokenOut: new (vmSdk.Address as any)(tokenOut),
    amount: amountForQuote,
    takerTraits: submitTraits,
  });
  const swapHash = await walletClient.sendTransaction({
    to: ROUTER,
    data: swapCall.data.toString() as Hex,
    value: 0n,
    chain: base,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  if (receipt.status !== "success") {
    return done({ decision: "skip", reason: "swap reverted on-chain", quotedOut: quotedOut.toString(), txHash: swapHash });
  }
  return done({
    decision: "fill",
    reason: "swap confirmed",
    quotedOut: quotedOut.toString(),
    txHash: swapHash,
    gasUsed: receipt.gasUsed.toString(),
  });
}
