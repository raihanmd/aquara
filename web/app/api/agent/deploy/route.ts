import { z } from "zod";
import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  type Address,
  type Hex,
  maxUint256,
} from "viem";
import { base } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { AQUA, AQUA_ROUTER } from "@/lib/config";
import { AQUA_BASE, aquaHeaders } from "@/lib/aqua-api";
import { agentSignAndSubmit, type CaliburCall } from "@/lib/calibur-agent";

export const dynamic = "force-dynamic";

const ADDR = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const bodySchema = z.object({
  maker: ADDR,
  capital: ADDR,
  capitalAmount: z.string().min(1),
  pairs: z
    .array(z.object({ tokenA: ADDR, tokenB: ADDR }))
    .min(1)
    .max(5),
  mode: z.enum(["conservative", "aggressive"]).default("conservative"),
  slippage: z.coerce.number().min(0.05).max(10).optional(),
});

const ERC20_MIN = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const APPROVE_SELECTOR = "0x095ea7b3";
const V6_ROUTER = "0x111111125421ca6dc452d289314280a0f8842a65" as Address;

async function usdPrices(
  tokens: string[],
  apiKey: string,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const pick = (json: any, t: string) => {
    const v = json[t] ?? json[t.toLowerCase()] ?? null;
    return v !== null && Number(v) > 0 ? Number(v) : null;
  };
  try {
    const joined = tokens.join(",");
    const res = await fetch(
      `https://api.1inch.com/price/v1.1/8453/${joined}?currency=USD`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (res.ok) {
      const json = await res.json();
      for (const t of tokens) out.set(t.toLowerCase(), pick(json, t));
      if ([...out.values()].every((v) => v === null)) throw new Error("empty batch");
      return out;
    }
  } catch {}
  for (const t of tokens) {
    try {
      const res = await fetch(
        `https://api.1inch.com/price/v1.1/8453/${t}?currency=USD`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) {
        out.set(t.toLowerCase(), null);
        continue;
      }
      out.set(t.toLowerCase(), pick(await res.json(), t));
    } catch {
      out.set(t.toLowerCase(), null);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const devLog = (...a: any[]) => {
  if (process.env.NODE_ENV !== "production") console.log("[deploy]", ...a);
};

function rangeAroundSpot(
  tokenA: string,
  tokenB: string,
  rateAperCap: number,
  rateBperCap: number,
  decA: number,
  decB: number,
): { min: bigint; max: bigint } | null {
  if (!(rateAperCap > 0) || !(rateBperCap > 0)) return null;
  if (!isFinite(rateAperCap) || !isFinite(rateBperCap)) return null;
  const aPerB = rateAperCap / rateBperCap;
  if (!(aPerB > 0) || !isFinite(aPerB)) return null;
  const hiIsA = tokenA.toLowerCase() > tokenB.toLowerCase();
  const h = hiIsA ? aPerB : 1 / aPerB;
  if (!(h > 0) || !isFinite(h)) return null;
  const decHi = hiIsA ? decA : decB;
  const decLo = hiIsA ? decB : decA;
  const scale = 10 ** (decHi - decLo);
  const toRaw = (hh: number) => BigInt(Math.floor(hh * 1e18 * scale));
  const toRawCeil = (hh: number) => {
    const v = hh * 1e18 * scale;
    return BigInt(Math.ceil(v));
  };
  const min = toRaw(h * 0.9);
  const max = toRawCeil(h * 1.1);
  if (min <= 0n || max <= min) return null;
  return { min, max };
}

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_MIN,
    functionName: "approve",
    args: [spender, amount],
  });
}

const isWhitelistedApprove = (_token: string) => true;

async function quoteSwap(
  src: string,
  dst: string,
  amount: bigint,
  from: string,
  slippage: number,
  apiKey: string,
): Promise<{ to: Address; data: Hex; value: bigint; out: bigint | null }> {
  const qs = new URLSearchParams({
    src,
    dst,
    amount: amount.toString(),
    from,
    slippage: String(slippage),
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.1inch.com/swap/v6.1/8453/swap?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const desc = (err as any)?.description || "";
      if (/allowance/i.test(desc) && attempt < 4) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw new Error(desc || `Swap quote failed (${res.status})`);
    }
  const json = await res.json();
  const outRaw = json.toAmount ?? json.dstAmount ?? json.toTokenAmount ?? null;
  return {
    to: json.tx.to as Address,
    data: json.tx.data as Hex,
    value: BigInt(json.tx.value ?? 0),
    out: outRaw !== null && outRaw !== undefined ? BigInt(outRaw) : null,
  };
  }
}

async function quoteOut(
  src: string,
  dst: string,
  amount: bigint,
  apiKey: string
): Promise<bigint | null> {
  try {
    const qs = new URLSearchParams({ src, dst, amount: amount.toString() });
    const res = await fetch(`https://api.1inch.com/swap/v6.1/8453/quote?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json.toAmount ?? json.dstAmount ?? json.toTokenAmount ?? null;
    return raw !== null && raw !== undefined ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json(
      { error: "maker, capital, capitalAmount, pairs[] required" },
      { status: 400 },
    );
  }
  const { maker, capital, capitalAmount, pairs, mode } = parsed.data;

  const settingsRow = await (prisma as any).makerSettings.findUnique({
    where: { maker: maker.toLowerCase() },
  });
  const slippage: number = parsed.data.slippage ?? settingsRow?.slippage ?? 0.5;

  const apiKey =
    process.env.ONEINCH_API_KEY || process.env.NEXT_PUBLIC_1INCH_API_KEY;
  if (!apiKey)
    return Response.json({ error: "ONEINCH_API_KEY missing" }, { status: 500 });

  const job = await prisma.agentJob.create({
    data: {
      maker: maker.toLowerCase(),
      chainId: 8453,
      kind: "deploy",
      status: "running",
      steps: [],
    },
  });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const steps: any[] = [];
      const pushStep = async (step: any) => {
        steps.push(step);
        await prisma.agentJob.update({
          where: { id: job.id },
          data: { steps },
        });
        send({ ...step, jobId: job.id });
      };

      try {
        const rpcUrl =
          process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.base.org";
        const publicClient = createPublicClient({
          chain: base,
          transport: http(rpcUrl),
        });

        const capDecimals = Number(
          await publicClient.readContract({
            address: capital as Address,
            abi: ERC20_MIN,
            functionName: "decimals",
          }),
        );
        const total = parseUnits(capitalAmount, capDecimals);
        if (total === 0n) throw new Error("Capital too small to split.");

        const aquaSdk = await import("@1inch/aqua-sdk");
        const vmSdk = await import("@1inch/swap-vm-sdk");
        const toAddr = (x: string) => new (aquaSdk.Address as any)(x);
        const toHex = (x: any) =>
          new (aquaSdk.HexString as any)(x?.toString?.() ?? x);
        const aqua = new (aquaSdk.AquaProtocolContract as any)(
          new (aquaSdk.Address as any)(AQUA),
        );

        if (total === 0n) throw new Error("Capital too small to split.");

        interface SwapLeg {
          to: Address;
          value: bigint;
          data: Hex;
          inRaw: bigint;
          outRaw: bigint;
          token: string;
        }
        interface PairPlan {
          idx: number;
          label: string;
          tokenA: string;
          tokenB: string;
          decA: number;
          decB: number;
          needA: bigint;
          needB: bigint;
          swaps: SwapLeg[];
          strategy: string;
          strategyHash: string;
          range: { min: string; max: string } | null;
          capSpent: bigint;
        }

        await pushStep({
          pair: 0,
          stage: "planning",
          detail: `allocating ${formatUnits(total, capDecimals)} across ${pairs.length} pair(s)`,
        });

        const capLow = capital.toLowerCase();
        const allToks = [
          ...new Set([
            capLow,
            ...pairs.flatMap((p) => [p.tokenA.toLowerCase(), p.tokenB.toLowerCase()]),
          ]),
        ];
        const [inv, allocMap, prices] = await Promise.all([
          publicClient.multicall({
            contracts: [
              ...allToks.map((t) => ({
                address: t as Address,
                abi: ERC20_MIN,
                functionName: "decimals",
              })),
              ...allToks.map((t) => ({
                address: t as Address,
                abi: ERC20_MIN,
                functionName: "balanceOf",
                args: [maker as Address],
              })),
            ],
          } as any),
          (async () => {
            const m = new Map<string, bigint>();
            try {
              const aq = await fetch(
                `${AQUA_BASE}/strategies/makers/${maker}?limit=50&chainIds=8453`,
                { headers: aquaHeaders(apiKey) },
              );
              if (aq.ok) {
                const aj = await aq.json();
                for (const s of aj.items ?? []) {
                  for (const t of s.tokens ?? []) {
                    const a = String(t?.address ?? "").toLowerCase();
                    const r = t?.currentBalance?.raw;
                    if (!a || r === undefined || r === null) continue;
                    try {
                      m.set(a, (m.get(a) ?? 0n) + BigInt(String(r)));
                    } catch {}
                  }
                }
              }
            } catch {}
            return m;
          })(),
          usdPrices(allToks, apiKey),
        ]);
        const decMap = new Map<string, number>();
        const walletMap = new Map<string, bigint>();
        allToks.forEach((t, k) => {
          const d = (inv as any)[k] as any;
          const b = (inv as any)[k + allToks.length] as any;
          if (!d || d.status !== "success") throw new Error(`cannot read token ${t.slice(0, 6)} on-chain`);
          decMap.set(t, Number(d.result));
          walletMap.set(t, b && b.status === "success" ? (b.result as bigint) : 0n);
        });
        const unalloc = new Map<string, bigint>(
          allToks.map((t) => {
            const u = (walletMap.get(t) ?? 0n) - (allocMap.get(t) ?? 0n);
            return [t, u > 0n ? u : 0n] as [string, bigint];
          }),
        );
        const capPrice = prices.get(capLow) ?? null;
        if (!capPrice) throw new Error(`USD price unavailable for capital - cannot plan budgets`);
        for (const t of allToks) {
          if ((prices.get(t) ?? null) === null)
            throw new Error(`USD price unavailable for ${t.slice(0, 6)} - cannot plan budgets`);
        }
        const totalUsd = (Number(total) / 10 ** (decMap.get(capLow) ?? 18)) * capPrice;
        const perPairUsd = totalUsd / pairs.length;

        const maySwap = pairs.some(
          (p) => p.tokenA.toLowerCase() !== capLow || p.tokenB.toLowerCase() !== capLow,
        );
        if (maySwap) {
          const allowRouter = (await publicClient.readContract({
            address: capital as Address,
            abi: ERC20_MIN,
            functionName: "allowance",
            args: [maker as Address, V6_ROUTER],
          })) as bigint;
          if (allowRouter < total) {
            if (!isWhitelistedApprove(capital)) {
              throw new Error(
                `approve router missing and ${capital.slice(0, 6)}… not whitelisted - approve ${V6_ROUTER.slice(0, 6)}… in your wallet first`,
              );
            }
            await pushStep({ pair: 0, stage: "approving", detail: "router allowance via agent" });
            await agentSignAndSubmit(maker as Address, [
              { to: capital as Address, value: 0n, data: encodeApprove(V6_ROUTER, maxUint256) },
            ]);
            const t0 = Date.now();
            for (;;) {
              const cur = (await publicClient.readContract({
                address: capital as Address,
                abi: ERC20_MIN,
                functionName: "allowance",
                args: [maker as Address, V6_ROUTER],
              })) as bigint;
              if (cur >= total || Date.now() - t0 > 45000) break;
              await sleep(2000);
            }
          }
        }
        const toRaw = (usd: number, t: string) => {
          const p = prices.get(t) ?? 0;
          const d = decMap.get(t) ?? 18;
          if (!(p > 0) || !(usd > 0)) return 0n;
          return BigInt(Math.floor((usd / p) * 10 ** d));
        };

        const withSalt = (s: any, salt: bigint) =>
          typeof s.withSalt === "function" ? s.withSalt(salt) : s;
        const withFee = (s: any, bps: number) =>
          typeof s.withFeeTokenIn === "function" ? s.withFeeTokenIn(bps) : s;
        const runSalt = BigInt(Date.now());
        const plans: PairPlan[] = [];

        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i];
          const aLow = pair.tokenA.toLowerCase();
          const bLow = pair.tokenB.toLowerCase();
          const decA = decMap.get(aLow) ?? 18;
          const decB = decMap.get(bLow) ?? 18;
          const label = `${pair.tokenA.slice(0, 6)}…/${pair.tokenB.slice(0, 6)}…`;
          let needA = toRaw(perPairUsd / 2, aLow);
          let needB = toRaw(perPairUsd / 2, bLow);
          if (needA === 0n && needB === 0n)
            throw new Error(`pair ${i + 1} budget dust - capital too small`);
          const swaps: SwapLeg[] = [];
          let capSpent = 0n;
          const cover = async (side: string, need: bigint): Promise<bigint> => {
            if (need === 0n) return 0n;
            const have = unalloc.get(side) ?? 0n;
            const fromWallet = have >= need ? need : have;
            unalloc.set(side, have - fromWallet);
            const short = need - fromWallet;
            if (short === 0n) return need;
            if (side === capLow)
              throw new Error(
                `pair ${i + 1}: capital shortfall ${formatUnits(short, decMap.get(side) ?? 18)} - wallet cannot cover`,
              );
            const shortUsd =
              (Number(short) / 10 ** (decMap.get(side) ?? 18)) * (prices.get(side) ?? 0);
            let inCap = BigInt(
              Math.ceil((shortUsd / (capPrice as number)) * 10 ** (decMap.get(capLow) ?? 18)),
            );
            if (inCap === 0n) inCap = 1n;
            const capHave = unalloc.get(capLow) ?? 0n;
            if (inCap > capHave)
              throw new Error(
                `pair ${i + 1}: capital shortfall - need ${formatUnits(inCap, decMap.get(capLow) ?? 18)} more`,
              );
            const q = await quoteSwap(capital, side, inCap, maker, slippage, apiKey);
            if (q.out === null || q.out === 0n)
              throw new Error(`pair ${i + 1}: no route ${capital.slice(0, 6)}→${side.slice(0, 6)}`);
            unalloc.set(capLow, capHave - inCap);
            capSpent += inCap;
            swaps.push({ to: q.to, value: q.value, data: q.data, inRaw: inCap, outRaw: q.out, token: side });
            return fromWallet + q.out;
          };
          needA = await cover(aLow, needA);
          needB = await cover(bLow, needB);
          devLog(`pair ${i} needs`, { needA: needA.toString(), needB: needB.toString(), swaps: swaps.length });

          let range: { min: string; max: string } | null = null;
          {
            const pA = prices.get(aLow) as number;
            const pB = prices.get(bLow) as number;
            const r = rangeAroundSpot(pair.tokenA, pair.tokenB, 1 / pA, 1 / pB, decA, decB);
            if (r) {
              range = { min: r.min.toString(), max: r.max.toString() };
              devLog(`pair ${i} range`, { min: range.min, max: range.max, pA, pB });
            }
          }
          const salt = runSalt * 1000n + BigInt(i);
          let program = withFee(withSalt((vmSdk.AquaXYCAmmStrategy as any).new(), salt), 5).build();
          if (range) {
            try {
              program = withFee(
                withSalt(
                  (vmSdk.AquaXYCAmmStrategy as any).newConcentrate({
                    rawPriceMin: BigInt(range.min),
                    rawPriceMax: BigInt(range.max),
                  }),
                  salt,
                ),
                10,
              ).build();
            } catch {
              program = withFee(withSalt((vmSdk.AquaXYCAmmStrategy as any).new(), salt), 5).build();
              range = null;
            }
          }
          const order = (vmSdk.Order as any).new({
            maker: new (vmSdk.Address as any)(maker),
            traits: (vmSdk.MakerTraits as any).default(),
            program,
          });
          const strategy = order.encode().toString();
          const strategyHash: string =
            typeof aquaSdk.AquaProtocolContract.calculateStrategyHash === "function"
              ? aquaSdk.AquaProtocolContract.calculateStrategyHash(strategy).toString()
              : "";
          plans.push({
            idx: i, label,
            tokenA: pair.tokenA, tokenB: pair.tokenB, decA, decB,
            needA, needB, swaps, strategy, strategyHash, range, capSpent,
          });
        }

        await pushStep({
          pair: 0,
          stage: "planned",
          detail: `${plans.length} pair(s), ${swapsTotal(plans)} swap(s), ${capLeft(plans, total).toFixed(4)} capital left over, mode=${mode}`,
        });

        for (const plan of plans) {
          for (const s of plan.swaps) {
            try {
              await publicClient.call({ to: s.to, data: s.data, value: s.value, account: maker as Address });
            } catch (e: any) {
              throw new Error(
                `pair ${plan.idx + 1} simulation failed - refusing to spend gas (${e?.shortMessage || e?.message || "swap would revert"})`,
              );
            }
          }
          const shipTx = aqua.ship({
            app: toAddr(AQUA_ROUTER),
            strategy: toHex(plan.strategy?.toString?.() ?? plan.strategy),
            amountsAndTokens: [
              { token: toAddr(plan.tokenA), amount: plan.needA },
              { token: toAddr(plan.tokenB), amount: plan.needB },
            ],
          });
          try {
            await publicClient.call({
              to: shipTx.to as Address,
              data: shipTx.data as Hex,
              value: BigInt(shipTx.value ?? 0),
              account: maker as Address,
            });
          } catch (e: any) {
            throw new Error(
              `pair ${plan.idx + 1} ship simulation failed (${e?.shortMessage || e?.message || "ship would revert"})`,
            );
          }
          (plan as any).shipCall = {
            to: shipTx.to as Address,
            value: BigInt(shipTx.value ?? 0),
            data: shipTx.data as Hex,
          };
        }

        await pushStep({ pair: 0, stage: "validated", detail: "all calls simulated - executing" });

        function swapsTotal(ps: PairPlan[]): number {
          return ps.reduce((n, p) => n + p.swaps.length, 0);
        }
        function capLeft(ps: PairPlan[], tot: bigint): number {
          const spent = ps.reduce((n, p) => n + p.capSpent, 0n);
          return Number(tot - spent) / 10 ** (decMap.get(capLow) ?? 18);
        }

        let okCount = 0;
        const balOfExec = async (tok: string) =>
          (await publicClient.readContract({
            address: tok as Address,
            abi: ERC20_MIN,
            functionName: "balanceOf",
            args: [maker as Address],
          })) as bigint;
        const allowOf = async (tok: string, spender: Address) =>
          (await publicClient.readContract({
            address: tok as Address,
            abi: ERC20_MIN,
            functionName: "allowance",
            args: [maker as Address, spender],
          })) as bigint;
        let remainingCapIn = plans.reduce(
          (n, pl) => n + pl.swaps.reduce((m, s) => m + s.inRaw, 0n),
          0n,
        );
        for (const plan of plans) {
          const i = plan.idx;
          try {
            const walletCap = await balOfExec(capital);
            const needCap = plan.swaps.reduce((m, s) => m + s.inRaw, 0n);
            if (walletCap < needCap) {
              await pushStep({
                pair: i,
                stage: "failed",
                detail: `capital short ${formatUnits(needCap - walletCap, decMap.get(capLow) ?? 18)} - stopping with partial progress`,
              });
              break;
            }
            const preA = await balOfExec(plan.tokenA);
            const preB = await balOfExec(plan.tokenB);
            if (plan.swaps.length > 0) {
              await pushStep({
                pair: i,
                stage: "swapping",
                detail: `${plan.swaps.length} swap(s) via 1inch (slippage ${slippage}%)`,
              });
              const { txHash: swapHash } = await agentSignAndSubmit(
                maker as Address,
                plan.swaps.map((s) => ({ to: s.to, value: s.value, data: s.data })),
              );
              await pushStep({
                pair: i,
                stage: "swapped",
                detail: "swaps confirmed on-chain",
                txHash: swapHash,
              });
              remainingCapIn -= needCap;
            }
            const awaitFresh = async (tok: string, pre: bigint) => {
              if (plan.swaps.length === 0) return balOfExec(tok);
              const t0 = Date.now();
              for (;;) {
                const cur = await balOfExec(tok);
                if (cur !== pre || Date.now() - t0 > 30000) return cur;
                await sleep(2000);
              }
            };
            const postA = await awaitFresh(plan.tokenA, preA);
            const postB = await awaitFresh(plan.tokenB, preB);
            devLog(`pair ${i} deltas`, {
              preA: preA.toString(), postA: postA.toString(),
              preB: preB.toString(), postB: postB.toString(),
            });
            const gotA = postA > preA ? postA - preA : 0n;
            const gotB = postB > preB ? postB - preB : 0n;
            if (plan.swaps.length > 0 && gotA === 0n && gotB === 0n) {
              await pushStep({
                pair: i,
                stage: "failed",
                detail: "swaps yielded nothing - skipping ship",
              });
              continue;
            }
            if (plan.needA > 0n || plan.needB > 0n) {
              const missing: { tok: string; amt: bigint }[] = [];
              for (const [tok, amt] of [
                [plan.tokenA, plan.needA],
                [plan.tokenB, plan.needB],
              ] as const) {
                if (amt === 0n) continue;
                const alw = await allowOf(tok, AQUA);
                if (alw < amt) {
                  if (!isWhitelistedApprove(tok)) {
                    throw new Error(
                      `approve ${tok.slice(0, 6)}… to Aqua missing and token not whitelisted - approve in your wallet first, then retry`,
                    );
                  }
                  missing.push({ tok, amt });
                }
              }
              if (missing.length > 0) {
                await pushStep({ pair: i, stage: "approving", detail: "aqua allowance via agent" });
                await agentSignAndSubmit(
                  maker as Address,
                  missing.map((m) => ({
                    to: m.tok as Address,
                    value: 0n,
                    data: encodeApprove(AQUA, maxUint256),
                  })),
                );
              }
            }
            if (plan.range) {
              await pushStep({ pair: i, stage: "ranged", detail: "concentrated +-10% around spot" });
            }
            const shipCall = (plan as any).shipCall as CaliburCall;
            await pushStep({
              pair: i,
              stage: "shipping",
              detail: `${formatUnits(plan.needA, plan.decA)} + ${formatUnits(plan.needB, plan.decB)} to ship`,
            });
            devLog(`pair ${i} shipCall`, { to: shipCall.to, dataLen: (shipCall.data?.length ?? 2) - 2, value: String(shipCall.value ?? 0) });
            let txHash: string;
            try {
              ({ txHash } = await agentSignAndSubmit(maker as Address, [shipCall]));
            } catch (e: any) {
              devLog(`pair ${i} ship submit failed`, {
                message: e?.message,
                shortMessage: e?.shortMessage,
                details: e?.details,
                cause: String(e?.cause?.message ?? e?.cause ?? "").slice(0, 500),
              });
              throw e;
            }
            await pushStep({ pair: i, stage: "deployed", detail: plan.label, txHash });
            try {
              if (plan.strategyHash) {
                await prisma.managedStrategy.upsert({
                  where: { strategyHash: plan.strategyHash },
                  update: { mode, priceMin: plan.range?.min ?? null, priceMax: plan.range?.max ?? null },
                  create: {
                    strategyHash: plan.strategyHash,
                    maker: maker.toLowerCase(),
                    chainId: 8453,
                    mode,
                    capitalToken: capital.toLowerCase(),
                    priceMin: plan.range?.min ?? null,
                    priceMax: plan.range?.max ?? null,
                  },
                });
                await prisma.agentDecision.create({
                  data: {
                    maker: maker.toLowerCase(),
                    chainId: 8453,
                    strategyHash: plan.strategyHash,
                    pair: plan.label,
                    action: "ship",
                    reason: `agent deployed (${mode})`,
                    txHash,
                  },
                });
              }
            } catch {}
            okCount++;
          } catch (e: any) {
            await pushStep({
              pair: i,
              stage: "failed",
              detail: e?.shortMessage || e?.message || "pair failed",
            });
          }
        }

        const leftoverCap = await balOfExec(capital).catch(() => 0n);
        await prisma.agentJob.update({
          where: { id: job.id },
          data: { status: okCount > 0 ? "done" : "failed", steps },
        });
        send({
          done: true,
          jobId: job.id,
          ok: okCount,
          total: pairs.length,
          leftover: formatUnits(leftoverCap, capDecimals),
        });
        controller.close();
      } catch (e: any) {
        const msg = e?.shortMessage || e?.message || "deploy failed";
        await prisma.agentJob.update({
          where: { id: job.id },
          data: { status: "failed", error: String(msg).slice(0, 2000) },
        });
        send({ done: true, jobId: job.id, error: msg });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const job = await prisma.agentJob.findUnique({ where: { id } });
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(job);
}
