import {
  type Runtime as DonRuntime,
  CronCapability,
  handlerInTee,
  Runner,
  type TeeRuntime,
  EVMClient,
  HTTPClient,
  ConfidentialHTTPClient,
  getNetwork,
  ok,
  json,
} from "@chainlink/cre-sdk";
import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeAbiParameters,
} from "viem";

export type Config = {
  schedule: string;
  makers: string[];
  apiBase: string;
  router: string;
  aquaRegistry: string;
  app: string;
  probeAmountRaw: string;
  chainSelectorName: string;
  aiApiUrl: string;
  aiModel: string;
  aiApiKeySecretId: string;
  aiApiKeyOwner: string;
  aiEnabled: boolean;
};

type Verdict =
  | "healthy"
  | "depleted"
  | "oor-suspect"
  | "thin-allowance"
  | "unreadable";

interface PositionReport {
  strategyHash: string;
  pair: string;
  mode: string;
  balanceA: string;
  balanceB: string;
  allowanceOk: boolean;
  quoteOk: boolean;
  quotedOut: string;
  verdict: Verdict;
  aiNote: string | null;
}

// Default exact-in TakerTraits packing: 20 zero offset bytes + flags 0x0041
// (bit0 exactIn + bit6 useTransferFromAndAquaPush). Pure constant, no SDK.
const TAKER_TRAITS_DEFAULT =
  "0x00000000000000000000000000000000000000000041";

const RAW_BALANCES_ABI = [
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

const ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const QUOTE_ABI = [
  {
    name: "quote",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOut", type: "uint256" }, { name: "orderHash", type: "bytes32" }],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHexLocal(b: Uint8Array): `0x${string}` {
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

// PHASE-2 stub (disabled via config aiEnabled=false). Single-hit design:
// ConfidentialHTTPClient executes ONCE inside the enclave (standard HTTPClient
// would fan out to every DON node = N billed AI calls). Secrets come from the
// Vault DON via template, never from config. NOT called while disabled.
async function maybeAskAI(
  runtime: TeeRuntime<Config>,
  cfg: Config,
  summary: string,
): Promise<string | null> {
  if (!cfg.aiEnabled) return null;
  const confClient = new ConfidentialHTTPClient();
  const donAI = runtime as unknown as DonRuntime<unknown>;
  const resp = confClient
    .sendRequest(donAI, {
      vaultDonSecrets: [{ key: cfg.aiApiKeySecretId, owner: cfg.aiApiKeyOwner }],
      request: {
        url: cfg.aiApiUrl,
        method: "POST",
        body: {
          value: JSON.stringify({
            model: cfg.aiModel,
            max_tokens: 300,
            messages: [
              {
                role: "user",
                content: `Classify rotation urgency for these Aqua positions (reply one word per line, hash: LOW/MEDIUM/HIGH):\n${summary}`,
              },
            ],
          }),
          case: "bodyString",
        } as never,
        multiHeaders: {
          "Content-Type": { values: ["application/json"] },
          Authorization: { values: ["Bearer {{.AI_API_KEY}}"] },
        },
        templatePublicValues: {},
        customRootCaCertPem: new Uint8Array(0),
        encryptOutput: false,
      },
    })
    .result();
  const body = JSON.parse(new TextDecoder().decode(resp.body));
  return String(body.choices?.[0]?.message?.content ?? "") || null;
}

export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
  const cfg = (runtime as unknown as { config: Config }).config;
  // Generated capabilities type their runtime as Runtime; the TEE docs pass
  // TeeRuntime straight through. Same load-bearing cast as the AI stub.
  const don = runtime as unknown as DonRuntime<unknown>;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName });
  if (!network) throw new Error(`unknown chain selector: ${cfg.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const http = new HTTPClient();

  const fetchJson = (url: string): unknown => {
    const response = http
      .sendRequest(runtime, { url, method: "GET", headers: {}, body: new Uint8Array(0) })
      .result();
    if (!ok(response)) throw new Error(`HTTP ${response.statusCode} for ${url.slice(0, 80)}`);
    return json(response);
  };

  const reports: PositionReport[] = [];

  let makers: string[] = [];
  try {
    const body = fetchJson(`${cfg.apiBase}/users?chainId=8453`) as unknown;
    const list = (Array.isArray(body) ? body : []) as unknown[];
    makers = list.filter((m) => typeof m === "string") as string[];
    runtime.log(`[watch] makers from api=${makers.length}`);
  } catch (e) {
    runtime.log(`[watch] users fetch failed, falling back to config: ${String(e).slice(0, 120)}`);
  }
  for (const extra of cfg.makers) {
    if (extra && !makers.some((m) => m.toLowerCase() === extra.toLowerCase())) makers.push(extra);
  }
  if (makers.length === 0) {
    runtime.log("[watch] no makers - nothing to do");
    return JSON.stringify({ summary: { makers: 0, positions: 0 }, reports });
  }

  for (const maker of makers) {
    runtime.log(`[watch] maker=${maker}`);
    let strategies: Array<{
      strategyHash: string;
      mode: string;
      strategyBytes: string;
      tokenA?: string;
      tokenB?: string;
      tokens: Array<{ address: string; symbol?: string }>;
    }> = [];
    try {
      const body = fetchJson(`${cfg.apiBase}/strategies?maker=${maker}&mode=aggressive`) as
        | { items?: Array<never> }
        | Array<never>;
      const items = (Array.isArray(body) ? body : body.items ?? []) as Array<{
        strategyHash: string;
        mode: string;
        strategyBytes: string;
        tokenA?: string;
        tokenB?: string;
        tokens: Array<{ address: string; symbol?: string }>;
      }>;
      strategies = items.filter((s) => s.strategyHash && s.strategyBytes);
    } catch (e) {
      runtime.log(`[watch] maker=${maker} strategies fetch failed: ${String(e).slice(0, 160)}`);
      continue;
    }
    runtime.log(`[watch] maker=${maker} aggressive=${strategies.length}`);

    for (const s of strategies) {
      const hash = s.strategyHash as `0x${string}`;
      const fromRow = [s.tokenA, s.tokenB].filter(Boolean) as string[];
      const fromApi = (s.tokens ?? []).slice(0, 2);
      const toks =
        fromRow.length >= 2
          ? fromRow.map((a, k) => ({
              address: a,
              symbol: fromApi[k]?.symbol,
            }))
          : fromApi;
      if (toks.length < 2) {
        runtime.log(`[watch] ${hash.slice(0, 10)} skip: need 2 tokens`);
        continue;
      }
      const [tA, tB] = toks;
      const pair = `${tA.symbol ?? tA.address.slice(0, 6)}/${tB.symbol ?? tB.address.slice(0, 6)}`;

      const evmCall = (to: string, dataHex: string): Uint8Array => {
        const reply = evm.callContract(don, {
          call: {
            from: hexToBytes(ZERO_ADDRESS),
            to: hexToBytes(to),
            data: hexToBytes(dataHex),
          },
        }).result();
        return reply.data;
      };

      const readRaw = (token: string): bigint => {
        try {
          const data = encodeFunctionData({
            abi: RAW_BALANCES_ABI,
            functionName: "rawBalances",
            args: [maker as `0x${string}`, cfg.app as `0x${string}`, hash, token as `0x${string}`],
          });
          const [bal] = decodeFunctionResult({
            abi: RAW_BALANCES_ABI,
            functionName: "rawBalances",
            data: bytesToHexLocal(evmCall(cfg.aquaRegistry, data)),
          }) as unknown as [bigint, number];
          return bal;
        } catch {
          return -1n;
        }
      };
      const balA = readRaw(tA.address);
      const balB = readRaw(tB.address);

      let allowanceOk = false;
      try {
        const data = encodeFunctionData({
          abi: ALLOWANCE_ABI,
          functionName: "allowance",
          args: [maker as `0x${string}`, cfg.aquaRegistry as `0x${string}`],
        });
        const check = (token: string): boolean => {
          try {
            const [alw] = decodeFunctionResult({
              abi: ALLOWANCE_ABI,
              functionName: "allowance",
              data: bytesToHexLocal(evmCall(token, data)),
            }) as unknown as [bigint];
            return alw > 0n;
          } catch {
            return false;
          }
        };
        allowanceOk = check(tA.address) && check(tB.address);
      } catch {
        allowanceOk = false;
      }

      let quoteOk = false;
      let quotedOut = 0n;
      const amount = BigInt(cfg.probeAmountRaw);
      if (balA >= 0n && balB >= 0n && (balA > 0n || balB > 0n)) {
        try {
          const [makerAddr, traits, orderData] = decodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
            s.strategyBytes as `0x${string}`,
          ) as unknown as [`0x${string}`, bigint, `0x${string}`];
          const inFirst = balA > 0n;
          const tokenIn = (inFirst ? tA.address : tB.address) as `0x${string}`;
          const tokenOut = (inFirst ? tB.address : tA.address) as `0x${string}`;
          const data = encodeFunctionData({
            abi: QUOTE_ABI,
            functionName: "quote",
            args: [
              { maker: makerAddr, traits, data: orderData },
              tokenIn,
              tokenOut,
              amount,
              TAKER_TRAITS_DEFAULT as `0x${string}`,
            ],
          });
          const [, out] = decodeFunctionResult({
            abi: QUOTE_ABI,
            functionName: "quote",
            data: bytesToHexLocal(evmCall(cfg.router, data)),
          }) as unknown as [bigint, bigint, `0x${string}`];
          quoteOk = true;
          quotedOut = out;
        } catch (e) {
          runtime.log(`[watch] ${hash.slice(0, 10)} quote reverted: ${String(e).slice(0, 120)}`);
          quoteOk = false;
        }
      } else {
        runtime.log(`[watch] ${hash.slice(0, 10)} quote skipped: unreadable balances`);
      }

      let verdict: Verdict;
      if (balA < 0n || balB < 0n) verdict = "unreadable";
      else if (balA === 0n && balB === 0n) verdict = "depleted";
      else if (!quoteOk) verdict = "oor-suspect";
      else if (!allowanceOk) verdict = "thin-allowance";
      else verdict = "healthy";

      runtime.log(
        `[watch] ${hash.slice(0, 10)} pair=${pair} balA=${balA} balB=${balB} ` +
          `allowanceOk=${allowanceOk} quoteOk=${quoteOk} quotedOut=${quotedOut} verdict=${verdict}`,
      );
      reports.push({
        strategyHash: hash,
        pair,
        mode: s.mode,
        balanceA: balA.toString(),
        balanceB: balB.toString(),
        allowanceOk,
        quoteOk,
        quotedOut: quotedOut.toString(),
        verdict,
        aiNote: null,
      });
    }
  }

  const summary = {
    makers: makers.length,
    positions: reports.length,
    healthy: reports.filter((r) => r.verdict === "healthy").length,
    depleted: reports.filter((r) => r.verdict === "depleted").length,
    oorSuspect: reports.filter((r) => r.verdict === "oor-suspect").length,
    thinAllowance: reports.filter((r) => r.verdict === "thin-allowance").length,
    unreadable: reports.filter((r) => r.verdict === "unreadable").length,
  };
  runtime.log(
    `[watch] summary makers=${summary.makers} positions=${summary.positions} ` +
      `healthy=${summary.healthy} depleted=${summary.depleted} oor-suspect=${summary.oorSuspect} ` +
      `thin-allowance=${summary.thinAllowance} unreadable=${summary.unreadable}`,
  );
  // STOP: watch-only. No writes by design (phase 2 adds dock/ship execution).
  return JSON.stringify({ summary, reports });
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [
    handlerInTee(cron.trigger({ schedule: config.schedule }), onCronTrigger, [
      { tee: "nitro", regions: ["us-west-2"] },
    ]),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
