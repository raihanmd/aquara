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
import { AQUA_BASE, aquaHeaders, pace } from "@/lib/aqua-api";
import { quoteSwapExact, lastQuoteDiag } from "@/lib/oneinch-quote";
import { verifyDeployIntent } from "@/lib/deploy-auth";
import { agentSignAndSubmit, simulateBatch, type CaliburCall } from "@/lib/calibur-agent";

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
  // Execution mode: sequential submits per pair/leg (dashboard default,
  // battle-tested), or batched (cron): one execute for approves+swaps, one
  // for ships. Batched is atomic per batch and cheaper, sequential isolates
  // failures per pair.
  execution: z.enum(["sequential", "batched"]).optional().default("sequential"),
  symbols: z.tuple([z.string().min(1).max(12), z.string().min(1).max(12)]).optional(),
  mode: z.literal("aggressive").default("aggressive"),
  // Demo-only: shift the range fully above spot so the position opens OOR.
  // Server-enforced dev-only (ignored in production).
  forceOor: z.boolean().optional().default(false),
  slippage: z.coerce.number().min(0.05).max(10).optional(),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  nonce: z.string().min(1),
  expiry: z.string().min(1),
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
  for (let attempt = 0; attempt < 4; attempt++) {
    await pace();
    if (attempt > 0) await sleep(2000 * attempt);
    try {
      const joined = tokens.join(",");
      const res = await fetch(
        `https://api.1inch.com/price/v1.1/8453/${joined}?currency=USD`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (res.status === 429 || res.status === 502 || res.status === 503) continue;
      if (res.ok) {
        const json = await res.json();
        for (const t of tokens) out.set(t.toLowerCase(), pick(json, t));
        if ([...out.values()].every((v) => v === null))
          throw new Error("empty batch");
        return out;
      }
    } catch {}
  }
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

async function tokenSymbols(apiKey: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const res = await fetch("https://api.1inch.com/token/v1.2/8453", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return m;
    const json = (await res.json()) as Record<string, { address?: string; symbol?: string }>;
    for (const t of Object.values(json)) {
      if (t?.address && t?.symbol) m.set(String(t.address).toLowerCase(), String(t.symbol));
    }
  } catch {}
  return m;
}

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
  // Single shared quoter (web/lib/oneinch-quote.ts): deploy and rotator
  // merge quote identically by construction - pacing, retries, slippage.
  const q = await quoteSwapExact({ apiKey, src, dst, amount, from, slippage });
  if (!q) throw new Error(lastQuoteDiag() || "Swap quote failed");
  return { to: q.to, data: q.data, value: q.value, out: q.dstAmount };
}

async function quoteOut(
  src: string,
  dst: string,
  amount: bigint,
  apiKey: string,
): Promise<bigint | null> {
  try {
    const qs = new URLSearchParams({ src, dst, amount: amount.toString() });
    const res = await fetch(
      `https://api.1inch.com/swap/v6.1/8453/quote?${qs}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json.toAmount ?? json.dstAmount ?? json.toTokenAmount ?? null;
    return raw !== null && raw !== undefined ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

async function runDeployPipeline(
  parsed: z.infer<typeof bodySchema>,
  opts?: { reasonTag?: string },
) {
  const { maker, capital, capitalAmount, pairs, mode } = parsed;
  const settingsRow = await (prisma as unknown as { makerSettings: { findUnique: (args: unknown) => Promise<{ slippage?: number } | null> } }).makerSettings.findUnique({
    where: { maker: maker.toLowerCase() },
  });
  const slippage: number = parsed.slippage ?? settingsRow?.slippage ?? 0.5;

  const apiKey =
    process.env.ONEINCH_API_KEY || process.env.NEXT_PUBLIC_1INCH_API_KEY;
  if (!apiKey)
    return Response.json({ error: "ONEINCH_API_KEY missing" }, { status: 500 });
  const symbols = await tokenSymbols(apiKey);

  // One deploy pipeline per maker at a time. Concurrent runs share the single
  // relayer EOA and collide on its transaction nonce even with per-relayer
  // serialization, because interleaved Calibur seq reads go stale. Jobs older
  // than 20 minutes count as orphaned (server restart) and do not block.
  const running = await prisma.agentJob.findFirst({
    where: {
      maker: maker.toLowerCase(),
      kind: "deploy",
      status: "running",
      createdAt: { gte: new Date(Date.now() - 20 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (running) {
    return Response.json(
      { error: "deploy already running for this maker", jobId: running.id },
      { status: 409 },
    );
  }

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
      const steps: unknown[] = [];
      const pushStep = async (step: unknown) => {
        steps.push(step);
        await prisma.agentJob.update({
          where: { id: job.id },
          data: { steps: steps as unknown as never },
        });
        send({ ...(step as Record<string, unknown>), jobId: job.id });
      };

      try {
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
        if (!rpcUrl) {
          throw new Error("NEXT_PUBLIC_RPC_URL missing - set your Alchemy RPC URL in web/.env");
        }
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
        let total = parseUnits(capitalAmount, capDecimals);
        if (total === 0n) throw new Error("Capital too small to split.");
        // Clamp to wallet: quotes drift above reality (slippage between the
        // rotator estimate and execution). Deploy with what is actually
        // there instead of failing the whole job on dust shortfall.
        try {
          const walletCap = (await publicClient.readContract({
            address: capital as Address,
            abi: ERC20_MIN,
            functionName: "balanceOf",
            args: [maker as Address],
          })) as bigint;
          if (walletCap < total) {
            await pushStep({
              pair: 0,
              stage: "budget",
              detail: `clamped ${formatUnits(total, capDecimals)} -> ${formatUnits(walletCap, capDecimals)} (wallet)`,
            });
            total = walletCap;
            if (total === 0n) throw new Error("Capital too small to split.");
          }
        } catch (e) {
          if ((e as Error)?.message === "Capital too small to split.") throw e;
        }

        const aquaSdk = await import("@1inch/aqua-sdk");
        const vmSdk = await import("@1inch/swap-vm-sdk");
        const toAddr = (x: string) => new (aquaSdk.Address as unknown as new (x: string) => unknown)(x);
        const toHex = (x: unknown) =>
          new (aquaSdk.HexString as unknown as new (x: string) => unknown)(String((x as { toString?: () => string })?.toString?.() ?? x));
        const aqua = new (aquaSdk.AquaProtocolContract as unknown as new (x: unknown) => { ship: (args: unknown) => { to: Address; data: Hex; value: bigint } })(new (aquaSdk.Address as unknown as new (x: string) => unknown)(AQUA));

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
          demoOor: boolean;
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
            ...pairs.flatMap((p) => [
              p.tokenA.toLowerCase(),
              p.tokenB.toLowerCase(),
            ]),
          ]),
        ];
        const [inv, allocMap, prices, aquaRates] = await Promise.all([
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
          } as unknown as never),
          (async () => {
            const m = new Map<string, bigint>();
            try {
              const aq = await fetch(
                `${AQUA_BASE}/strategies/makers/${maker}?limit=50&chainIds=8453`,
                { headers: aquaHeaders(apiKey) },
              );
              if (aq.ok) {
                const aj = await aq.json() as { items?: Array<{ tokens?: Array<{ address?: string; currentBalance?: { raw?: string } }> }> };
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
          (async () => {
            // Fallback USD rates from Aqua's own balance data (raw + usd per
            // token). Covers obscure tokens the 1inch price API doesn't know.
            const rates = new Map<string, number>();
            try {
              const aq = await fetch(
                `${AQUA_BASE}/strategies/makers/${maker}?limit=50&chainIds=8453`,
                { headers: aquaHeaders(apiKey) },
              );
              if (aq.ok) {
                const aj = await aq.json() as { items?: Array<{ tokens?: Array<{ address?: string; currentBalance?: { raw?: string; usd?: number | null } }> }> };
                for (const s of aj.items ?? []) {
                  for (const t of s.tokens ?? []) {
                    const a = String(t?.address ?? "").toLowerCase();
                    const r = t?.currentBalance?.raw;
                    const u = t?.currentBalance?.usd;
                    if (!a || r === undefined || r === null || typeof u !== "number" || !(u > 0)) continue;
                    try {
                      const raw = BigInt(String(r));
                      if (raw > 0n && !rates.has(a)) rates.set(a, u / Number(raw));
                    } catch {}
                  }
                }
              }
            } catch {}
            return rates;
          })(),
        ]);
        const decMap = new Map<string, number>();
        const walletMap = new Map<string, bigint>();
        allToks.forEach((t, k) => {
          const d = (inv as unknown as Array<{ status: string; result?: unknown }>)[k];
          const b = (inv as unknown as Array<{ status: string; result?: unknown }>)[k + allToks.length];
          if (!d || d.status !== "success")
            throw new Error(`cannot read token ${t.slice(0, 6)} on-chain`);
          decMap.set(t, Number(d.result));
          walletMap.set(
            t,
            b && b.status === "success" ? (b.result as bigint) : 0n,
          );
        });
        const unalloc = new Map<string, bigint>(
          allToks.map((t) => {
            const u = (walletMap.get(t) ?? 0n) - (allocMap.get(t) ?? 0n);
            return [t, u > 0n ? u : 0n] as [string, bigint];
          }),
        );
        // aquaRates are per-raw-unit; scale to per-token with onchain decimals.
        for (const [t, rate] of aquaRates) {
          if ((prices.get(t) ?? null) !== null || !(rate > 0)) continue;
          const dec = decMap.get(t);
          if (dec === undefined) continue;
          prices.set(t, rate * 10 ** dec);
        }
        const capPrice = prices.get(capLow) ?? null;
        if (!capPrice)
          throw new Error(
            `USD price unavailable for capital - cannot plan budgets`,
          );
        for (const t of allToks) {
          if ((prices.get(t) ?? null) === null)
            throw new Error(
              `USD price unavailable for ${t.slice(0, 6)} - cannot plan budgets`,
            );
        }
        const totalUsd =
          (Number(total) / 10 ** (decMap.get(capLow) ?? 18)) * capPrice;
        const perPairUsd = totalUsd / pairs.length;

        const maySwap = pairs.some(
          (p) =>
            p.tokenA.toLowerCase() !== capLow ||
            p.tokenB.toLowerCase() !== capLow,
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
            await pushStep({
              pair: 0,
              stage: "approving",
              detail: "router allowance via agent",
            });
            await agentSignAndSubmit(maker as Address, [
              {
                to: capital as Address,
                value: 0n,
                data: encodeApprove(V6_ROUTER, maxUint256),
              },
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

        const withSalt = (s: unknown, salt: bigint) => {
          const maybe = s as { withSalt?: (salt: bigint) => unknown };
          return typeof maybe.withSalt === "function" ? maybe.withSalt(salt) : s;
        };
        const withFee = (s: unknown, bps: number) => {
          const maybe = s as { withFeeTokenIn?: (bps: number) => unknown };
          return typeof maybe.withFeeTokenIn === "function" ? maybe.withFeeTokenIn(bps) : s;
        };
        const runSalt = BigInt(Date.now());
        const plans: PairPlan[] = [];

        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i];
          const aLow = pair.tokenA.toLowerCase();
          const bLow = pair.tokenB.toLowerCase();
          const decA = decMap.get(aLow) ?? 18;
          const decB = decMap.get(bLow) ?? 18;
          const symOf = (a: string, fallback?: string) =>
            symbols.get(a.toLowerCase()) ?? fallback ?? `${a.slice(0, 6)}…`;
          const given = parsed.symbols;
          const label =
            given && pairs.length === 1
              ? `${given[0]}/${given[1]}`
              : `${symOf(pair.tokenA)}/${symOf(pair.tokenB)}`;
          // Demo OOR ships single-sided: the band sits fully above spot, so a
          // concentrated position holds 100% token0 (lower address) and the
          // other side would idle. Full budget goes to the held side.
          const forceOorSingle =
            process.env.NODE_ENV !== "production" && parsed.forceOor === true;
          const aIsToken0 = aLow < bLow;
          let needA: bigint;
          let needB: bigint;
          if (forceOorSingle) {
            needA = aIsToken0 ? toRaw(perPairUsd, aLow) : 0n;
            needB = aIsToken0 ? 0n : toRaw(perPairUsd, bLow);
          } else {
            needA = toRaw(perPairUsd / 2, aLow);
            needB = toRaw(perPairUsd / 2, bLow);
          }
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
            if (side === capLow) {
              // Same dust tolerance as the swap branch: quote/slippage drift
              // leaves needs a hair above wallet. Below $0.01 deploy with
              // what is there instead of failing the whole job.
              const shortUsd =
                (Number(short) / 10 ** (decMap.get(side) ?? 18)) *
                (prices.get(side) ?? 0);
              if (shortUsd < 0.01) return fromWallet;
              throw new Error(
                `pair ${i + 1} (${label}): capital shortfall - need ${formatUnits(need, decMap.get(side) ?? 18)} ${symOf(side)} but wallet has ${formatUnits(have, decMap.get(side) ?? 18)} (short ${formatUnits(short, decMap.get(side) ?? 18)} ~$${shortUsd.toFixed(4)})`,
              );
            }
            const shortUsd =
              (Number(short) / 10 ** (decMap.get(side) ?? 18)) *
              (prices.get(side) ?? 0);
            let inCap = BigInt(
              Math.ceil(
                (shortUsd / (capPrice as number)) *
                  10 ** (decMap.get(capLow) ?? 18),
              ),
            );
            if (inCap === 0n) inCap = 1n;
            const capHave = unalloc.get(capLow) ?? 0n;
            if (inCap > capHave) {
              // Slippage dust: quoted swap outputs land a hair under plan.
              // Below $0.01 just deploy slightly less instead of failing.
              const shortCapUsd =
                (Number(inCap - capHave) / 10 ** (decMap.get(capLow) ?? 18)) *
                (capPrice as number);
              if (shortCapUsd >= 0.01)
                throw new Error(
                  `pair ${i + 1} (${label}): capital shortfall - need ${formatUnits(inCap, decMap.get(capLow) ?? 18)} ${symOf(capLow)} for the ${symOf(side)} swap but have ${formatUnits(capHave, decMap.get(capLow) ?? 18)} (short $${shortCapUsd.toFixed(4)})`,
                );
              inCap = capHave;
              if (inCap === 0n) return fromWallet;
            }
            const q = await quoteSwap(
              capital,
              side,
              inCap,
              maker,
              slippage,
              apiKey,
            );
            if (q.out === null || q.out === 0n)
              throw new Error(
                `pair ${i + 1}: no route ${capital.slice(0, 6)}→${side.slice(0, 6)}`,
              );
            unalloc.set(capLow, capHave - inCap);
            capSpent += inCap;
            swaps.push({
              to: q.to,
              value: q.value,
              data: q.data,
              inRaw: inCap,
              outRaw: q.out,
              token: side,
            });
            return fromWallet + q.out;
          };
          needA = await cover(aLow, needA);
          needB = await cover(bLow, needB);
          devLog(`pair ${i} needs`, {
            needA: needA.toString(),
            needB: needB.toString(),
            swaps: swaps.length,
          });

          let range: { min: string; max: string } | null = null;
          let demoOor = false;
          {
            const pA = prices.get(aLow) as number;
            const pB = prices.get(bLow) as number;
            const r = rangeAroundSpot(
              pair.tokenA,
              pair.tokenB,
              1 / pA,
              1 / pB,
              decA,
              decB,
            );
            if (r) {
              range = { min: r.min.toString(), max: r.max.toString() };
              if (process.env.NODE_ENV !== "production" && parsed.forceOor === true) {
                range = { min: (r.max * 2n).toString(), max: (r.max * 3n).toString() };
                demoOor = true;
              }
              devLog(`pair ${i} range`, {
                min: range.min,
                max: range.max,
                pA,
                pB,
                demoOor: range.min !== r.min.toString(),
              });
            }
          }
          const salt = runSalt * 1000n + BigInt(i);
          let program = (withFee(
            withSalt((vmSdk.AquaXYCAmmStrategy as unknown as { new: () => unknown }).new(), salt),
            5,
          ) as { build: () => unknown }).build();
          if (range) {
            try {
              program = (withFee(
                withSalt(
                  (vmSdk.AquaXYCAmmStrategy as unknown as { newConcentrate: (args: unknown) => unknown }).newConcentrate({
                    rawPriceMin: BigInt(range.min),
                    rawPriceMax: BigInt(range.max),
                  }),
                  salt,
                ),
                10,
              ) as { build: () => unknown }).build();
            } catch {
              program = (withFee(
                withSalt((vmSdk.AquaXYCAmmStrategy as unknown as { new: () => unknown }).new(), salt),
                5,
              ) as { build: () => unknown }).build();
              range = null;
            }
          }
          const order = (vmSdk.Order as unknown as { new: (args: unknown) => { encode: () => { toString: () => string } } }).new({
            maker: new (vmSdk.Address as unknown as new (x: string) => unknown)(maker),
            traits: (vmSdk.MakerTraits as unknown as { default: () => unknown }).default(),
            program,
          });
          const strategy = order.encode().toString();
          const strategyHash: string =
            typeof (aquaSdk.AquaProtocolContract as unknown as { calculateStrategyHash?: (s: string) => { toString: () => string } }).calculateStrategyHash ===
            "function"
              ? (aquaSdk.AquaProtocolContract as unknown as { calculateStrategyHash: (s: string) => { toString: () => string } }).calculateStrategyHash(
                  strategy,
                ).toString()
              : "";
          plans.push({
            idx: i,
            label,
            tokenA: pair.tokenA,
            tokenB: pair.tokenB,
            decA,
            decB,
            needA,
            needB,
            swaps,
            strategy,
            strategyHash,
            range,
            capSpent,
            demoOor,
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
              await publicClient.call({
                to: s.to,
                data: s.data,
                value: s.value,
                account: maker as Address,
              });
            } catch (e: unknown) {
              const err = e as { shortMessage?: string; message?: string };
              throw new Error(
                `pair ${plan.idx + 1} simulation failed - refusing to spend gas (${err?.shortMessage || err?.message || "swap would revert"})`,
              );
            }
          }
          const shipTx = (aqua as unknown as { ship: (args: unknown) => { to: Address; data: Hex; value: bigint } }).ship({
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
          } catch (e: unknown) {
            const err = e as { shortMessage?: string; message?: string };
            throw new Error(
              `pair ${plan.idx + 1} ship simulation failed (${err?.shortMessage || err?.message || "ship would revert"})`,
            );
          }
          (plan as unknown as { shipCall: CaliburCall }).shipCall = {
            to: shipTx.to as Address,
            value: BigInt(shipTx.value ?? 0),
            data: shipTx.data as Hex,
          };
        }

        await pushStep({
          pair: 0,
          stage: "validated",
          detail: "all calls simulated - executing",
        });

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
        if (parsed.execution === "batched") {
          // Batch 1: every approval + every swap leg in ONE execute. Atomic:
          // revert means nothing moved, funds stay put.
          const needRouterTotal = plans.reduce(
            (n, pl) => n + pl.swaps.reduce((m, s) => m + s.inRaw, 0n),
            0n,
          );
          const batch1: CaliburCall[] = [];
          if (needRouterTotal > 0n) {
            const allowRouter = await allowOf(capital, V6_ROUTER);
            if (allowRouter < needRouterTotal) {
              if (!isWhitelistedApprove(capital)) {
                throw new Error(
                  `approve router missing and ${capital.slice(0, 6)}… not whitelisted - approve ${V6_ROUTER.slice(0, 6)}… in your wallet first`,
                );
              }
              batch1.push({
                to: capital as Address,
                value: 0n,
                data: encodeApprove(V6_ROUTER, maxUint256),
              });
            }
          }
          const aquaNeeds = new Map<string, bigint>();
          for (const pl of plans) {
            if (pl.needA > 0n)
              aquaNeeds.set(pl.tokenA, pl.needA > (aquaNeeds.get(pl.tokenA) ?? 0n) ? pl.needA : (aquaNeeds.get(pl.tokenA) ?? 0n));
            if (pl.needB > 0n)
              aquaNeeds.set(pl.tokenB, pl.needB > (aquaNeeds.get(pl.tokenB) ?? 0n) ? pl.needB : (aquaNeeds.get(pl.tokenB) ?? 0n));
          }
          for (const [tok, amt] of aquaNeeds) {
            const alw = await allowOf(tok, AQUA);
            if (alw < amt) {
              if (!isWhitelistedApprove(tok)) {
                throw new Error(
                  `approve ${tok.slice(0, 6)}… to Aqua missing and token not whitelisted - approve in your wallet first, then retry`,
                );
              }
              batch1.push({
                to: tok as Address,
                value: 0n,
                data: encodeApprove(AQUA, maxUint256),
              });
            }
          }
          const allLegs = plans.flatMap((pl) =>
            pl.swaps.map((s) => ({ plan: pl, leg: s })),
          );
          for (const { leg } of allLegs) {
            batch1.push({ to: leg.to, value: leg.value, data: leg.data });
          }
          if (batch1.length > 0) {
            const simErr = await simulateBatch(maker as Address, batch1);
            if (simErr) {
              // Name the failing leg: simulate each call solo so the error
              // says WHICH approve/swap reverts instead of "unknown reason".
              const bad: string[] = [];
              for (let li = 0; li < batch1.length; li++) {
                const legErr = await simulateBatch(maker as Address, [batch1[li]]);
                if (legErr) bad.push(`leg${li}->${batch1[li].to.slice(0, 6)}:${legErr.slice(0, 80)}`);
              }
              throw new Error(
                `batched approve+swap simulation failed (${simErr})${bad.length > 0 ? ` [${bad.join(" | ")}]` : ""}`,
              );
            }
            await pushStep({
              pair: 0,
              stage: "swapping",
              detail: `${allLegs.length} swap(s) in one batch`,
            });
            const { txHash: swapBatchHash } = await agentSignAndSubmit(
              maker as Address,
              batch1,
            );
            await pushStep({
              pair: 0,
              stage: "swapped",
              detail: "batched swaps confirmed on-chain",
              txHash: swapBatchHash,
            });
            remainingCapIn = 0n;
          }
          // Measure, then batch 2: every ship in ONE execute. Clamp needs to
          // measured post-swap balances: quotes drift above reality and a
          // ship pulling even dust more than present reverts the batch.
          const shipPlans: typeof plans = [];
          for (const plan of plans) {
            const i = plan.idx;
            const postA = await balOfExec(plan.tokenA);
            const postB = await balOfExec(plan.tokenB);
            if (postA === 0n && postB === 0n) {
              await pushStep({
                pair: i,
                stage: "failed",
                detail: "swaps yielded nothing - skipping ship",
              });
              continue;
            }
            if (plan.needA > postA || plan.needB > postB) {
              await pushStep({
                pair: i,
                stage: "clamped",
                detail: `ship needs clamped to measured: ${formatUnits(plan.needA, plan.decA)}+${formatUnits(plan.needB, plan.decB)} -> ${formatUnits(postA < plan.needA ? postA : plan.needA, plan.decA)}+${formatUnits(postB < plan.needB ? postB : plan.needB, plan.decB)}`,
              });
              plan.needA = postA < plan.needA ? postA : plan.needA;
              plan.needB = postB < plan.needB ? postB : plan.needB;
              const shipTx = (aqua as unknown as { ship: (args: unknown) => { to: Address; data: Hex; value: bigint } }).ship({
                app: toAddr(AQUA_ROUTER),
                strategy: toHex(plan.strategy?.toString?.() ?? plan.strategy),
                amountsAndTokens: [
                  { token: toAddr(plan.tokenA), amount: plan.needA },
                  { token: toAddr(plan.tokenB), amount: plan.needB },
                ],
              });
              (plan as unknown as { shipCall: CaliburCall }).shipCall = {
                to: shipTx.to as Address,
                value: BigInt(shipTx.value ?? 0),
                data: shipTx.data as Hex,
              };
            }
            if (plan.range) {
              await pushStep({
                pair: i,
                stage: "ranged",
                detail: plan.demoOor
                  ? "demo range pushed off-spot (intentionally OOR)"
                  : "concentrated +-10% around spot",
              });
            }
            const shipCall = (plan as unknown as { shipCall: CaliburCall }).shipCall;
            await pushStep({
              pair: i,
              stage: "shipping",
              detail: `${formatUnits(plan.needA, plan.decA)} + ${formatUnits(plan.needB, plan.decB)} to ship`,
            });
            shipPlans.push(plan);
          }
          if (shipPlans.length > 0) {
            const shipCalls = shipPlans.map(
              (pl) => (pl as unknown as { shipCall: CaliburCall }).shipCall,
            );
            const simErr = await simulateBatch(maker as Address, shipCalls);
            if (simErr)
              throw new Error(`batched ship simulation failed (${simErr})`);
            const { txHash: shipBatchHash } = await agentSignAndSubmit(
              maker as Address,
              shipCalls,
            );
            for (const plan of shipPlans) {
              const i = plan.idx;
              await pushStep({
                pair: i,
                stage: "deployed",
                detail: plan.label,
                txHash: shipBatchHash,
              });
              try {
                if (plan.strategyHash) {
                  await prisma.managedStrategy.upsert({
                    where: { strategyHash: plan.strategyHash },
                    update: {
                      mode,
                      priceMin: plan.range?.min ?? null,
                      priceMax: plan.range?.max ?? null,
                      strategyBytes: plan.strategy,
                      tokenA: plan.tokenA.toLowerCase(),
                      tokenB: plan.tokenB.toLowerCase(),
                    },
                    create: {
                      strategyHash: plan.strategyHash,
                      maker: maker.toLowerCase(),
                      chainId: 8453,
                      mode,
                      capitalToken: capital.toLowerCase(),
                      priceMin: plan.range?.min ?? null,
                      priceMax: plan.range?.max ?? null,
                      strategyBytes: plan.strategy,
                      tokenA: plan.tokenA.toLowerCase(),
                      tokenB: plan.tokenB.toLowerCase(),
                    },
                  });
                  await prisma.agentDecision.create({
                    data: {
                      maker: maker.toLowerCase(),
                      chainId: 8453,
                      strategyHash: plan.strategyHash,
                      pair: plan.label,
                      action: "ship",
                      reason: opts?.reasonTag ? `${opts.reasonTag} (${mode})` : `agent deployed (${mode})`,
                      txHash: shipBatchHash,
                    },
                  });
                }
              } catch {}
              okCount++;
            }
          }
        } else
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
              devLog(
                `pair ${i} swapCalls`,
                plan.swaps.map((s) => ({
                  to: s.to,
                  value: String(s.value ?? 0),
                  dataLen: (s.data?.length ?? 2) - 2,
                  inRaw: s.inRaw.toString(),
                })),
              );
              let swapHash = "";
              for (let si = 0; si < plan.swaps.length; si++) {
                const leg = plan.swaps[si];
                const submitOne = async (data: Hex) => {
                  const { txHash } = await agentSignAndSubmit(
                    maker as Address,
                    [{ to: leg.to, value: leg.value, data }],
                  );
                  return txHash;
                };
                try {
                  swapHash = await submitOne(leg.data);
                } catch (e: unknown) {
                  const err = e as { message?: string; shortMessage?: string; details?: unknown; cause?: { message?: string } };
                  devLog(`pair ${i} swap ${si} submit failed`, {
                    message: err?.message,
                    shortMessage: err?.shortMessage,
                    details: err?.details,
                    cause: String(err?.cause?.message ?? err?.cause ?? "").slice(
                      0,
                      500,
                    ),
                  });
                  try {
                    await pushStep({
                      pair: i,
                      stage: "swapping",
                      detail: `retry swap ${si + 1}/${plan.swaps.length} with fresh quote`,
                    });
                    const fresh = await quoteSwap(
                      capital,
                      leg.token,
                      leg.inRaw,
                      maker,
                      slippage,
                      apiKey,
                    );
                    swapHash = await submitOne(fresh.data);
                  } catch (e2: unknown) {
                    devLog(`pair ${i} swap ${si} retry failed`, {
                      message: (e2 as { message?: string })?.message ?? String(e2),
                    });
                    throw e2;
                  }
                }
              }
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
              preA: preA.toString(),
              postA: postA.toString(),
              preB: preB.toString(),
              postB: postB.toString(),
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
                await pushStep({
                  pair: i,
                  stage: "approving",
                  detail: "aqua allowance via agent",
                });
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
              await pushStep({
                pair: i,
                stage: "ranged",
                detail: plan.demoOor
                  ? "demo range pushed off-spot (intentionally OOR)"
                  : "concentrated +-10% around spot",
              });
            }
            const shipCall = (plan as unknown as { shipCall: CaliburCall }).shipCall;
            await pushStep({
              pair: i,
              stage: "shipping",
              detail: `${formatUnits(plan.needA, plan.decA)} + ${formatUnits(plan.needB, plan.decB)} to ship`,
            });
            devLog(`pair ${i} shipCall`, {
              to: shipCall.to,
              dataLen: (shipCall.data?.length ?? 2) - 2,
              value: String(shipCall.value ?? 0),
            });
            let txHash: string;
            try {
              ({ txHash } = await agentSignAndSubmit(maker as Address, [
                shipCall,
              ]));
            } catch (e: unknown) {
              const err = e as { message?: string; shortMessage?: string; details?: unknown; cause?: { message?: string } };
              devLog(`pair ${i} ship submit failed`, {
                message: err?.message,
                shortMessage: err?.shortMessage,
                details: err?.details,
                cause: String(err?.cause?.message ?? err?.cause ?? "").slice(
                  0,
                  500,
                ),
              });
              throw e;
            }
            await pushStep({
              pair: i,
              stage: "deployed",
              detail: plan.label,
              txHash,
            });
            try {
              if (plan.strategyHash) {
                await prisma.managedStrategy.upsert({
                  where: { strategyHash: plan.strategyHash },
                  update: {
                    mode,
                    priceMin: plan.range?.min ?? null,
                    priceMax: plan.range?.max ?? null,
                    strategyBytes: plan.strategy,
                    tokenA: plan.tokenA.toLowerCase(),
                    tokenB: plan.tokenB.toLowerCase(),
                  },
                  create: {
                    strategyHash: plan.strategyHash,
                    maker: maker.toLowerCase(),
                    chainId: 8453,
                    mode,
                    capitalToken: capital.toLowerCase(),
                    priceMin: plan.range?.min ?? null,
                    priceMax: plan.range?.max ?? null,
                    strategyBytes: plan.strategy,
                    tokenA: plan.tokenA.toLowerCase(),
                    tokenB: plan.tokenB.toLowerCase(),
                  },
                });
                await prisma.agentDecision.create({
                  data: {
                    maker: maker.toLowerCase(),
                    chainId: 8453,
                    strategyHash: plan.strategyHash,
                    pair: plan.label,
                    action: "ship",
                    reason: opts?.reasonTag ? `${opts.reasonTag} (${mode})` : `agent deployed (${mode})`,
                    txHash,
                  },
                });
              }
            } catch {}
            okCount++;
          } catch (e: unknown) {
            const err = e as { shortMessage?: string; message?: string };
            await pushStep({
              pair: i,
              stage: "failed",
              detail: err?.shortMessage || err?.message || "pair failed",
            });
          }
        }

        const leftoverCap = await balOfExec(capital).catch(() => 0n);
        await prisma.agentJob.update({
          where: { id: job.id },
          data: { status: okCount > 0 ? "done" : "failed", steps: steps as unknown as never },
        });
        send({
          done: true,
          jobId: job.id,
          ok: okCount,
          total: pairs.length,
          leftover: formatUnits(leftoverCap, capDecimals),
        });
        controller.close();
      } catch (e: unknown) {
        const err = e as { shortMessage?: string; message?: string };
        const msg = err?.shortMessage || err?.message || "deploy failed";
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

export async function POST(req: Request) {
  const rawBody = await req.json().catch(() => ({}));

  // Internal cron path: the rotator service redeploys docked capital for
  // delegated makers. No wallet signature exists here, so the service key
  // replaces it. Maker must be delegated and mode must be aggressive.
  const cronKey = process.env.CRON_API_KEY;
  if (cronKey && req.headers.get("x-cron-key") === cronKey) {
    const cronSchema = bodySchema.omit({ signature: true, nonce: true, expiry: true });
    const cronParsed = cronSchema.safeParse(rawBody);
    if (!cronParsed.success) {
      return Response.json(
        { error: "maker, capital, capitalAmount, pairs[] required" },
        { status: 400 },
      );
    }

    const managed = await prisma.managedUser.findUnique({
      where: { address: cronParsed.data.maker.toLowerCase() },
    });
    if (!managed) {
      return Response.json({ error: "maker not delegated" }, { status: 403 });
    }
    console.log(`[deploy][cron] maker=${cronParsed.data.maker.toLowerCase()} pairs=${cronParsed.data.pairs.length}`);
    return runDeployPipeline(
      {
        ...cronParsed.data,
        signature: "0x",
        nonce: String(Date.now()),
        expiry: String(Date.now() + 300000),
      },
      { reasonTag: "cron rotation" },
    );
  }

  // Wallet-sig path: every dashboard deploy requires the maker's intent signature.
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: "maker, capital, capitalAmount, pairs[] required" },
      { status: 400 },
    );
  }

  const auth = await verifyDeployIntent(parsed.data as unknown as Record<string, unknown>, parsed.data.signature);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  return runDeployPipeline(parsed.data);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const job = await prisma.agentJob.findUnique({ where: { id } });
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(job);
}
