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
import { AQUA, AQUA_ROUTER, KNOWN_TOKENS } from "@/lib/config";
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
] as const;

const APPROVE_SELECTOR = "0x095ea7b3";
const V6_ROUTER = "0x111111125421ca6dc452d289314280a0f8842a65" as Address;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_MIN,
    functionName: "approve",
    args: [spender, amount],
  });
}

const isWhitelistedApprove = (token: string) =>
  KNOWN_TOKENS.some((t) => t.toLowerCase() === token.toLowerCase());

async function quoteSwap(
  src: string,
  dst: string,
  amount: bigint,
  from: string,
  slippage: number,
  apiKey: string,
): Promise<{ to: Address; data: Hex; value: bigint }> {
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
    return {
      to: json.tx.to as Address,
      data: json.tx.data as Hex,
      value: BigInt(json.tx.value ?? 0),
    };
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
        const perPair = total / BigInt(pairs.length);
        if (perPair === 0n) throw new Error("Capital too small to split.");

        const aquaSdk = await import("@1inch/aqua-sdk");
        const vmSdk = await import("@1inch/swap-vm-sdk");
        const toAddr = (x: string) => new (aquaSdk.Address as any)(x);
        const toHex = (x: any) =>
          new (aquaSdk.HexString as any)(x?.toString?.() ?? x);
        const aqua = new (aquaSdk.AquaProtocolContract as any)(
          new (aquaSdk.Address as any)(AQUA),
        );

        let okCount = 0;
        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i];
          const label = `${pair.tokenA.slice(0, 6)}…/${pair.tokenB.slice(0, 6)}…`;
          try {
            const capLow = capital.toLowerCase();
            const aLow = pair.tokenA.toLowerCase();
            const bLow = pair.tokenB.toLowerCase();

            const decA = Number(
              await publicClient.readContract({
                address: pair.tokenA as Address,
                abi: ERC20_MIN,
                functionName: "decimals",
              }),
            );
            const decB = Number(
              await publicClient.readContract({
                address: pair.tokenB as Address,
                abi: ERC20_MIN,
                functionName: "decimals",
              }),
            );

            let amtA = 0n;
            let amtB = 0n;
            const calls: CaliburCall[] = [];

            if (aLow === capLow || bLow === capLow) {
              if (aLow === capLow) amtA = perPair;
              else amtB = perPair;
              await pushStep({
                pair: i,
                stage: "funded",
                detail: `single-sided ${formatUnits(perPair, aLow === capLow ? decA : decB)}`,
              });
            } else {
              const half = perPair / 2n;
              const capAllowRouter = (await publicClient.readContract({
                address: capital as Address,
                abi: ERC20_MIN,
                functionName: "allowance",
                args: [maker as Address, V6_ROUTER],
              })) as bigint;
              if (capAllowRouter < perPair) {
                if (!isWhitelistedApprove(capital)) {
                  throw new Error(
                    `approve router missing and ${capital.slice(0, 6)}… not whitelisted - approve ${V6_ROUTER.slice(0, 6)}… in your wallet first`,
                  );
                }
                await pushStep({
                  pair: i,
                  stage: "approving",
                  detail: "router allowance via agent",
                });
                await agentSignAndSubmit(maker as Address, [
                  {
                    to: capital as Address,
                    value: 0n,
                    data: encodeApprove(V6_ROUTER, perPair),
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
                  if (cur >= perPair || Date.now() - t0 > 45000) break;
                  await sleep(2000);
                }
              }
              await pushStep({
                pair: i,
                stage: "swapping",
                detail: `swapping half via 1inch (slippage ${slippage}%)`,
              });
              const qA = await quoteSwap(
                capital,
                pair.tokenA,
                half,
                maker,
                slippage,
                apiKey,
              );
              const qB = await quoteSwap(
                capital,
                pair.tokenB,
                perPair - half,
                maker,
                slippage,
                apiKey,
              );
              calls.push({ to: qA.to, value: qA.value, data: qA.data });
              calls.push({ to: qB.to, value: qB.value, data: qB.data });
              await pushStep({
                pair: i,
                stage: "swapped",
                detail: "swap calldata embedded",
              });
              amtA = 0n;
              amtB = 0n;
            }

            const program = (vmSdk.AquaXYCAmmStrategy as any).new().build();
            const order = (vmSdk.Order as any).new({
              maker: new (vmSdk.Address as any)(maker),
              traits: (vmSdk.MakerTraits as any).default(),
              program,
            });
            const strategy = order.encode();

            for (const [tok, amt] of [
              [pair.tokenA, amtA],
              [pair.tokenB, amtB],
            ] as const) {
              if (amt === 0n) continue;
              const alw = (await publicClient.readContract({
                address: tok as Address,
                abi: ERC20_MIN,
                functionName: "allowance",
                args: [maker as Address, AQUA],
              })) as bigint;
              if (alw < amt) {
                if (!isWhitelistedApprove(tok)) {
                  throw new Error(
                    `approve ${tok.slice(0, 6)}… to Aqua missing and token not whitelisted - approve in your wallet first, then retry`,
                  );
                }
                await pushStep({
                  pair: i,
                  stage: "approving",
                  detail: tok.slice(0, 10),
                });
                calls.push({
                  to: tok as Address,
                  value: 0n,
                  data: encodeApprove(AQUA, maxUint256),
                });
              }
            }

            const shipTx = aqua.ship({
              app: toAddr(AQUA_ROUTER),
              strategy: toHex(strategy?.toString?.() ?? strategy),
              amountsAndTokens: [
                { token: toAddr(pair.tokenA), amount: amtA },
                { token: toAddr(pair.tokenB), amount: amtB },
              ],
            });
            calls.push({
              to: shipTx.to as Address,
              value: BigInt(shipTx.value ?? 0),
              data: shipTx.data as Hex,
            });

            await pushStep({
              pair: i,
              stage: "shipping",
              detail: `batch of ${calls.length} calls`,
            });

            const { txHash } = await agentSignAndSubmit(
              maker as Address,
              calls,
            );
            await pushStep({
              pair: i,
              stage: "deployed",
              detail: label,
              txHash,
            });

            try {
              const strategyHash: string =
                typeof aquaSdk.AquaProtocolContract.calculateStrategyHash ===
                "function"
                  ? aquaSdk.AquaProtocolContract.calculateStrategyHash(
                      strategy,
                    ).toString()
                  : "";
              if (strategyHash) {
                await prisma.managedStrategy.upsert({
                  where: { strategyHash },
                  update: { mode },
                  create: {
                    strategyHash,
                    maker: maker.toLowerCase(),
                    chainId: 8453,
                    mode,
                    capitalToken: capital.toLowerCase(),
                  },
                });
                await prisma.agentDecision.create({
                  data: {
                    maker: maker.toLowerCase(),
                    chainId: 8453,
                    strategyHash,
                    pair: label,
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

        await prisma.agentJob.update({
          where: { id: job.id },
          data: { status: okCount > 0 ? "done" : "failed", steps },
        });
        send({ done: true, jobId: job.id, ok: okCount, total: pairs.length });
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
