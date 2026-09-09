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
  /** Minimum 24h volume USD below which aggressive position is flagged trash (default 1.0) */
  trashMinVolumeUsd: number;
  /** Max APY % below which aggressive position is flagged trash; null disables check (default null) */
  trashMaxApyPct: number | null;
  /** If true, aggressive with zero volume in both 24h and 7d windows is trash (default true) */
  trashZeroVolumeBothWindows: boolean;
  /** Demo override: strategyHashes always forced to trash, case-insensitive (default []) */
  demoForceTrashHashes: string[];
  /** Demo override: if true, every aggressive position is trash (default false) */
  demoTrashAllAggressive: boolean;
};

type Verdict =
  | "healthy"
  | "depleted"
  | "side-depleted"
  | "oor-suspect"
  | "thin-allowance"
  | "unreadable";

interface PositionReport {
  strategyHash: string;
  pair: string;
  mode: string;
  apiState: string | null;
  balanceA: string;
  balanceB: string;
  allowanceOk: boolean;
  quoteOk: boolean;
  quotedOut: string;
  verdict: Verdict;
  rotationCandidate: boolean;
  trash: boolean;
  trashReason: string | null;
  sharedCoverage: Array<{ token: string; wallet: string; committed: string }>;
  aiNote: string | null;
}

// Default exact-in TakerTraits packing: 20 zero offset bytes + flags 0x0041
// (bit0 exactIn + bit6 useTransferFromAndAquaPush). Pure constant, no SDK.
const TAKER_TRAITS_DEFAULT = "0x00000000000000000000000000000000000000000041";

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
    outputs: [
      { name: "balance", type: "uint248" },
      { name: "tokensCount", type: "uint8" },
    ],
  },
] as const;

const ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
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
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOut", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface AggRet {
  success: boolean;
  returnData: `0x${string}`;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decodeAggregate3(dataHex: string): AggRet[] {
  const h = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const w = (i: number): string => h.slice(i * 64, i * 64 + 64);
  const n = parseInt(w(1), 16);
  if (!Number.isSafeInteger(n) || n > 10000)
    throw new Error(`bad aggregate3 length ${n}`);
  const out: AggRet[] = [];
  for (let i = 0; i < n; i++) {
    const rel = parseInt(w(2 + i), 16) / 32;
    const abs = 2 + rel;
    const success = parseInt(w(abs), 16) !== 0;
    const dRel = parseInt(w(abs + 1), 16) / 32;
    const dAbs = Math.floor(abs + dRel);
    const dLen = parseInt(w(dAbs), 16);
    if (!Number.isSafeInteger(dLen) || dLen > h.length / 2)
      throw new Error("bad row bytes");
    out.push({
      success,
      returnData: ("0x" +
        h.slice((dAbs + 1) * 64, (dAbs + 1) * 64 + dLen * 2)) as `0x${string}`,
    });
  }
  return out;
}

function bytesToHexLocal(b: Uint8Array): `0x${string}` {
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

function extractAiContent(raw: string): string {
  try {
    const j = JSON.parse(raw);
    const c = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? "";
    if (typeof c === "string" && c) return c;
    if (Array.isArray(c)) {
      const s = c.map((p: { text?: string }) => p?.text ?? "").join("");
      if (s) return s;
    }
  } catch {}
  try {
    const chunks: string[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      chunks.push(payload);
    }
    const full = chunks
      .map((c) => {
        try {
          const jj = JSON.parse(c);
          const dd =
            jj?.choices?.[0]?.delta?.content ??
            jj?.choices?.[0]?.message?.content ??
            "";
          return typeof dd === "string" ? dd : "";
        } catch {
          return "";
        }
      })
      .join("");
    if (full) return full;
  } catch {}
  return "";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
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
  try {
    const probe = runtime
      .getSecret({ id: cfg.aiApiKeySecretId })
      .result().value;
    void probe;
  } catch (e) {
    throw new Error(
      `ai secret missing: ${cfg.aiApiKeySecretId} (${String(e).slice(0, 100)})`,
    );
  }
  const confClient = new ConfidentialHTTPClient();
  const donAI = runtime as unknown as DonRuntime<unknown>;
  const resp = confClient
    .sendRequest(donAI, {
      vaultDonSecrets: [
        { key: cfg.aiApiKeySecretId, owner: cfg.aiApiKeyOwner },
      ],
      request: {
        url: cfg.aiApiUrl,
        method: "POST",
        bodyString: JSON.stringify({
          model: cfg.aiModel,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: `You classify Aqua liquidity position rotation urgency. Input lines look like: <strategyHash> <pair> <verdict> balA=<raw> balB=<raw> trash=<true|false>. Verdict meanings: healthy=in range and fillable; depleted=both balances zero; side-depleted=one side drained to zero; oor-suspect=out of range, quote reverted; thin-allowance=fillable but Aqua allowance too low; unreadable=chain read failed. Decide level by these rules in order: unreadable=>LOW; depleted or side-depleted=>HIGH; trash=true=>HIGH; oor-suspect=>MEDIUM; thin-allowance=>MEDIUM; healthy=>LOW. Reply ONLY a JSON array, no other text: [{"hash":"<full 66-char strategyHash exactly as in input>","level":"LOW|MEDIUM|HIGH"}]. Copy each hash exactly, never truncate.\n${summary}`,
            },
          ],
        }),
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
  const body = new TextDecoder().decode(resp.body);
  return extractAiContent(body) || null;
}

export const onCronTrigger = async (
  runtime: TeeRuntime<Config>,
): Promise<string> => {
  const cfg = (runtime as unknown as { config: Config }).config;
  const trashMinVolumeUsd =
    typeof cfg.trashMinVolumeUsd === "number" && isFinite(cfg.trashMinVolumeUsd)
      ? cfg.trashMinVolumeUsd
      : 1.0;
  const trashMaxApyPct =
    typeof cfg.trashMaxApyPct === "number" && isFinite(cfg.trashMaxApyPct)
      ? cfg.trashMaxApyPct
      : null;
  const trashZeroVolumeBothWindows =
    typeof cfg.trashZeroVolumeBothWindows === "boolean"
      ? cfg.trashZeroVolumeBothWindows
      : true;
  const demoForceTrashHashes: string[] = Array.isArray(cfg.demoForceTrashHashes)
    ? cfg.demoForceTrashHashes.filter((s) => typeof s === "string")
    : [];
  const demoTrashAllAggressive =
    typeof cfg.demoTrashAllAggressive === "boolean"
      ? cfg.demoTrashAllAggressive
      : false;
  const demoForceSet = new Set(
    demoForceTrashHashes.map((h) => h.toLowerCase()),
  );

  const don = runtime.usingTheDons();
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: cfg.chainSelectorName,
  });
  if (!network)
    throw new Error(`unknown chain selector: ${cfg.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const http = new HTTPClient();

  const fetchJson = (url: string): unknown => {
    const response = http
      .sendRequest(runtime, {
        url,
        method: "GET",
        headers: {},
        body: new Uint8Array(0),
      })
      .result();
    if (!ok(response))
      throw new Error(`HTTP ${response.statusCode} for ${url.slice(0, 80)}`);
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
    runtime.log(
      `[watch] users fetch failed, falling back to config: ${String(e).slice(0, 120)}`,
    );
  }
  for (const extra of cfg.makers) {
    if (extra && !makers.some((m) => m.toLowerCase() === extra.toLowerCase()))
      makers.push(extra);
  }
  if (makers.length === 0) {
    runtime.log("[watch] no makers - nothing to do");
    return JSON.stringify({ summary: { makers: 0, positions: 0 }, reports });
  }

  for (const maker of makers) {
    runtime.log(`[watch] maker=${maker}`);
    let live: Array<{
      strategyHash: string;
      strategyBytes?: string;
      classification?: { state?: string };
      tokens: Array<{
        address: string;
        symbol?: string;
        currentBalance?: { raw?: string };
        initialBalance?: { raw?: string };
      }>;
    }> = [];
    const dbRows = new Map<
      string,
      {
        mode: string;
        strategyBytes?: string;
        tokenA?: string;
        tokenB?: string;
        performance?: {
          volume?: { last24h?: { usd?: unknown }; last7d?: { usd?: unknown } };
          fees?: {
            last24h?: { apy?: unknown };
            last7d?: { apy?: unknown };
            total?: { apy?: unknown };
          };
        };
      }
    >();
    try {
      const body = fetchJson(
        `${cfg.apiBase}/strategies?maker=${maker}`,
      ) as unknown;
      const rows = (Array.isArray(body) ? body : []) as Array<{
        strategyHash: string;
        mode: string;
        strategyBytes?: string;
        tokenA?: string;
        tokenB?: string;
        performance?: {
          volume?: { last24h?: { usd?: unknown }; last7d?: { usd?: unknown } };
          fees?: {
            last24h?: { apy?: unknown };
            last7d?: { apy?: unknown };
            total?: { apy?: unknown };
          };
        };
      }>;
      for (const r of rows ?? []) {
        if (r?.strategyHash)
          dbRows.set(String(r.strategyHash).toLowerCase(), r);
      }
    } catch (e) {
      runtime.log(
        `[watch] maker=${maker} modes fetch failed: ${String(e).slice(0, 120)}`,
      );
    }
    try {
      const body = fetchJson(
        `${cfg.apiBase}/aqua/positions?maker=${maker}&chainIds=8453&limit=50`,
      ) as unknown;
      const items = (
        Array.isArray(body)
          ? body
          : ((body as { items?: unknown })?.items ?? [])
      ) as Array<{
        strategyHash?: string;
        strategyBytes?: string;
        classification?: { state?: string };
        tokens?: Array<{
          address?: string;
          symbol?: string;
          currentBalance?: { raw?: string } | string;
          initialBalance?: { raw?: string } | string;
        }>;
      }>;
      for (const it of items ?? []) {
        if (!it?.strategyHash) continue;
        live.push({
          strategyHash: String(it.strategyHash),
          strategyBytes: it.strategyBytes,
          classification: it.classification,
          tokens: (it.tokens ?? []).map((t) => ({
            address: String(t?.address ?? ""),
            symbol: t?.symbol,
            currentBalance:
              typeof t?.currentBalance === "string"
                ? { raw: t.currentBalance }
                : t?.currentBalance,
            initialBalance:
              typeof t?.initialBalance === "string"
                ? { raw: t.initialBalance }
                : t?.initialBalance,
          })),
        });
      }
    } catch (e) {
      runtime.log(
        `[watch] maker=${maker} positions fetch failed: ${String(e).slice(0, 120)}`,
      );
    }
    runtime.log(
      `[watch] maker=${maker} live=${live.length} tracked=${dbRows.size}`,
    );

    const evmCall = (to: string, dataHex: string): Uint8Array => {
      const reply = evm
        .callContract(don, {
          call: {
            from: hexToBytes(ZERO_ADDRESS),
            to: hexToBytes(to),
            data: hexToBytes(dataHex),
          },
        })
        .result();
      return reply.data;
    };

    const BALANCEOF_ABI = [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const;
    const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
    const AGG_ABI = [
      {
        name: "aggregate3",
        type: "function",
        stateMutability: "view",
        inputs: [
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "allowFailure", type: "bool" },
              { name: "callData", type: "bytes" },
            ],
          },
        ],
        outputs: [
          {
            name: "returnData",
            type: "tuple[]",
            components: [
              { name: "success", type: "bool" },
              { name: "returnData", type: "bytes" },
            ],
          },
        ],
      },
    ] as const;

    const isLimitErr = (e: unknown): boolean =>
      /limit|capability call limit|too many|rate/i.test(
        String((e as Error)?.message ?? e ?? ""),
      );

    // Batch ALL reads per maker into ONE multicall: strategy balances,
    // allowances and wallet balances. Falls back to per-call reads when the
    // multicall itself fails for non-limit reasons.
    interface ReadRow {
      kind: "bal" | "allow" | "wallet";
      hash: string;
      token: string;
    }
    const batchRows: ReadRow[] = [];
    for (const p of live) {
      const h = String(p.strategyHash ?? "").toLowerCase();
      const row = dbRows.get(h);
      const addrs = [
        ...new Set(
          [row?.tokenA, row?.tokenB, ...(p.tokens ?? []).map((t) => t.address)]
            .filter(Boolean)
            .map((a) => String(a).toLowerCase()),
        ),
      ].slice(0, 2);
      for (const a of addrs) batchRows.push({ kind: "bal", hash: h, token: a });
    }
    const uniqToks: string[] = [];
    for (const p of live) {
      for (const t of p.tokens ?? []) {
        const a = String(t?.address ?? "").toLowerCase();
        if (a && !uniqToks.includes(a)) uniqToks.push(a);
      }
    }
    for (const a of uniqToks) {
      batchRows.push({ kind: "allow", hash: "", token: a });
      batchRows.push({ kind: "wallet", hash: "", token: a });
    }

    const balMap = new Map<string, bigint>();
    const allowMap = new Map<string, boolean | null>();
    const walletMap = new Map<string, bigint>();
    let infraDegraded = false;
    const encodeRowCall = (r: ReadRow): `0x${string}` => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hex = (abi: any, fn: string, args: any[]) =>
        encodeFunctionData({
          abi,
          functionName: fn,
          args,
        }) as unknown as `0x${string}`;
      if (r.kind === "bal")
        return hex(RAW_BALANCES_ABI, "rawBalances", [
          maker as `0x${string}`,
          cfg.app as `0x${string}`,
          r.hash as `0x${string}`,
          r.token as `0x${string}`,
        ]);
      if (r.kind === "allow")
        return hex(ALLOWANCE_ABI, "allowance", [
          maker as `0x${string}`,
          cfg.aquaRegistry as `0x${string}`,
        ]);
      return hex(BALANCEOF_ABI, "balanceOf", [maker as `0x${string}`]);
    };
    const rowTarget = (r: ReadRow): `0x${string}` =>
      (r.kind === "bal" ? cfg.aquaRegistry : r.token) as `0x${string}`;
    try {
      const data = encodeFunctionData({
        abi: AGG_ABI,
        functionName: "aggregate3",
        args: [
          batchRows.map((r) => ({
            target: rowTarget(r) as `0x${string}`,
            allowFailure: true,
            callData: encodeRowCall(r),
          })),
        ],
      });
      const rawHex = bytesToHexLocal(evmCall(MULTICALL3, data));
      const rets = decodeAggregate3(rawHex);
      if (!Array.isArray(rets) || rets.length !== batchRows.length) {
        const succ = Array.isArray(rets)
          ? rets.filter((r) => r?.success).length
          : -1;
        throw new Error(
          `multicall shape mismatch (rows=${batchRows.length} got=${Array.isArray(rets) ? rets.length : typeof rets} ok=${succ} rawLen=${rawHex.length})`,
        );
      }
      rets.forEach((ret, k) => {
        const r = batchRows[k];
        if (!ret?.success) {
          runtime.log(
            `[watch] row-fail kind=${r.kind} target=${r.token.slice(0, 10)}`,
          );
          return;
        }
        try {
          if (r.kind === "bal") {
            const [bal] = decodeFunctionResult({
              abi: RAW_BALANCES_ABI,
              functionName: "rawBalances",
              data: ret.returnData,
            }) as unknown as [bigint, number];
            balMap.set(`${r.hash}:${r.token}`, bal);
          } else if (r.kind === "allow") {
            const [alw] = decodeFunctionResult({
              abi: ALLOWANCE_ABI,
              functionName: "allowance",
              data: ret.returnData,
            }) as unknown as [bigint];
            allowMap.set(r.token, alw > 0n);
          } else {
            const [bal] = decodeFunctionResult({
              abi: BALANCEOF_ABI,
              functionName: "balanceOf",
              data: ret.returnData,
            }) as unknown as [bigint];
            walletMap.set(r.token, bal);
          }
        } catch {}
      });
      runtime.log(`[watch] maker=${maker} multicall ok rows=${rets.length}`);
    } catch (e) {
      const em = e as Error;
      if (isLimitErr(e)) {
        infraDegraded = true;
        runtime.log(
          `[watch] maker=${maker} multicall hit chain-read limit - degraded mode`,
        );
      } else {
        runtime.log(
          `[watch] maker=${maker} multicall failed: ${em?.name ?? "?"}: ${String(em?.message ?? e).slice(0, 200)}`,
        );
        runtime.log(`[watch] maker=${maker} falling back to individual reads`);
        for (const r of batchRows) {
          try {
            const one = encodeRowCall(r);
            const target = rowTarget(r);
            const ret = evmCall(target, one);
            if (r.kind === "bal") {
              const [bal] = decodeFunctionResult({
                abi: RAW_BALANCES_ABI,
                functionName: "rawBalances",
                data: bytesToHexLocal(ret),
              }) as unknown as [bigint, number];
              balMap.set(`${r.hash}:${r.token}`, bal);
            } else if (r.kind === "allow") {
              const [alw] = decodeFunctionResult({
                abi: ALLOWANCE_ABI,
                functionName: "allowance",
                data: bytesToHexLocal(ret),
              }) as unknown as [bigint];
              allowMap.set(r.token, alw > 0n);
            } else {
              const [bal] = decodeFunctionResult({
                abi: BALANCEOF_ABI,
                functionName: "balanceOf",
                data: bytesToHexLocal(ret),
              }) as unknown as [bigint];
              walletMap.set(r.token, bal);
            }
          } catch {}
        }
        runtime.log(`[watch] maker=${maker} fallback reads done`);
      }
    }

    const committedOf = new Map<string, bigint>();
    for (const a of uniqToks) {
      let sum = 0n;
      for (const p of live) {
        for (const t of p.tokens ?? []) {
          if (String(t?.address ?? "").toLowerCase() !== a) continue;
          const r = t?.currentBalance?.raw;
          if (r === undefined || r === null) continue;
          try {
            sum += BigInt(String(r));
          } catch {}
        }
      }
      committedOf.set(a, sum);
    }
    const sharedCoverage = uniqToks.map((a) => ({
      token: a,
      wallet: (walletMap.get(a) ?? -1n).toString(),
      committed: (committedOf.get(a) ?? 0n).toString(),
    }));
    runtime.log(
      `[watch] maker=${maker} shared=` +
        sharedCoverage
          .map((c) => `${c.token.slice(0, 6)}:w=${c.wallet}:c=${c.committed}`)
          .join(" "),
    );

    for (const p of live) {
      const hash = p.strategyHash as `0x${string}`;
      const row = dbRows.get(hash.toLowerCase());
      const mode = row?.mode ?? "stable";
      const s = {
        strategyHash: p.strategyHash,
        mode,
        strategyBytes: row?.strategyBytes ?? p.strategyBytes ?? "",
        tokenA: row?.tokenA,
        tokenB: row?.tokenB,
        tokens: (p.tokens ?? []).map((t) => ({
          address: t.address,
          symbol: t.symbol,
          initialRaw: (t as { initialBalance?: { raw?: string } })
            .initialBalance?.raw,
        })),
      };
      const apiState =
        (p.classification as { state?: string } | undefined)?.state ?? null;
      const fromRow = [s.tokenA, s.tokenB].filter(Boolean) as string[];
      const fromApi = (s.tokens ?? []).slice(0, 2);
      const toks =
        fromRow.length >= 2
          ? fromRow.map((a, k) => ({
              address: a,
              symbol: fromApi[k]?.symbol,
              initialRaw: undefined as string | undefined,
            }))
          : fromApi.map(
              (t: {
                address: string;
                symbol?: string;
                initialRaw?: string;
              }) => ({
                address: t.address,
                symbol: t.symbol,
                initialRaw: t.initialRaw,
              }),
            );
      if (toks.length < 2) {
        runtime.log(`[watch] ${hash.slice(0, 10)} skip: need 2 tokens`);
        continue;
      }
      const [tA, tB] = toks;
      const pair = `${tA.symbol ?? tA.address.slice(0, 6)}/${tB.symbol ?? tB.address.slice(0, 6)}`;

      const h = hash.toLowerCase();
      const balA = balMap.get(`${h}:${tA.address.toLowerCase()}`) ?? -1n;
      const balB = balMap.get(`${h}:${tB.address.toLowerCase()}`) ?? -1n;

      const alA = allowMap.get(tA.address.toLowerCase());
      const alB = allowMap.get(tB.address.toLowerCase());
      const allowanceOk = alA === true && alB === true;

      let quoteOk = false;
      let quotedOut = 0n;
      const amount = BigInt(cfg.probeAmountRaw);
      if (infraDegraded) {
        runtime.log(
          `[watch] ${hash.slice(0, 10)} quote skipped: degraded mode, saving call budget`,
        );
      } else if (balA >= 0n && balB >= 0n && (balA > 0n || balB > 0n)) {
        try {
          const [decoded] = decodeAbiParameters(
            [
              {
                type: "tuple",
                components: [
                  { type: "address", name: "maker" },
                  { type: "uint256", name: "traits" },
                  { type: "bytes", name: "data" },
                ],
              },
            ],
            s.strategyBytes as `0x${string}`,
          ) as unknown as [
            { maker: `0x${string}`; traits: bigint; data: `0x${string}` },
          ];
          const makerAddr = decoded.maker;
          const traits = decoded.traits;
          const orderData = decoded.data;
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
          if (isLimitErr(e)) {
            infraDegraded = true;
            runtime.log(
              `[watch] ${hash.slice(0, 10)} quote skipped: chain-read limit`,
            );
          } else {
            runtime.log(
              `[watch] ${hash.slice(0, 10)} quote reverted: ${String(e).slice(0, 120)}`,
            );
          }
          quoteOk = false;
        }
      }

      let verdict: Verdict;
      const initOf = new Map<string, string>();
      for (const t of (p.tokens ?? []) as Array<{
        address?: string;
        currentBalance?: { raw?: string };
        initialBalance?: { raw?: string };
      }>) {
        const a = String(t?.address ?? "").toLowerCase();
        if (!a) continue;
        initOf.set(`${a}:cur`, String(t?.currentBalance?.raw ?? ""));
        initOf.set(`${a}:ini`, String(t?.initialBalance?.raw ?? ""));
      }
      const sideDepleted = toks.some((t) => {
        const a = String(t.address ?? "").toLowerCase();
        const cur = initOf.get(`${a}:cur`) ?? "";
        const ini = initOf.get(`${a}:ini`) ?? "";
        if (!cur || !ini) return false;
        try {
          return BigInt(ini) > 0n && BigInt(cur) === 0n;
        } catch {
          return false;
        }
      });
      if (infraDegraded) verdict = "unreadable";
      else if (balA < 0n || balB < 0n) verdict = "unreadable";
      else if (balA === 0n && balB === 0n) verdict = "depleted";
      else if (sideDepleted) verdict = "side-depleted";
      else if (!quoteOk) verdict = "oor-suspect";
      else if (!allowanceOk) verdict = "thin-allowance";
      else verdict = "healthy";

      const perf = row?.performance;
      const v24 = numOrNull(perf?.volume?.last24h?.usd);
      const v7 = numOrNull(perf?.volume?.last7d?.usd);
      const apy =
        numOrNull(perf?.fees?.last24h?.apy) ??
        numOrNull(perf?.fees?.last7d?.apy) ??
        numOrNull(perf?.fees?.total?.apy);

      let trash = false;
      let trashReason: string | null = null;
      if (s.mode !== "aggressive") {
        trash = false;
      } else if (demoForceSet.has(hash.toLowerCase())) {
        trash = true;
        trashReason = "demo-force";
      } else if (demoTrashAllAggressive) {
        trash = true;
        trashReason = "demo-all";
      } else if (
        trashZeroVolumeBothWindows &&
        v24 !== null &&
        v7 !== null &&
        v24 === 0 &&
        v7 === 0
      ) {
        trash = true;
        trashReason = "zero-volume-both-windows";
      } else if (v24 !== null && v24 < trashMinVolumeUsd) {
        trash = true;
        trashReason = "low-volume-24h";
      } else if (
        trashMaxApyPct !== null &&
        apy !== null &&
        apy < trashMaxApyPct
      ) {
        trash = true;
        trashReason = "low-apy";
      }

      const rotationCandidate =
        s.mode === "aggressive" &&
        (verdict === "oor-suspect" ||
          verdict === "depleted" ||
          verdict === "side-depleted" ||
          trash);

      runtime.log(
        `[watch] ${hash.slice(0, 10)} pair=${pair} mode=${s.mode} apiState=${apiState ?? "?"} balA=${balA} balB=${balB} ` +
          `allowanceOk=${allowanceOk} quoteOk=${quoteOk} quotedOut=${quotedOut} verdict=${verdict} ` +
          `trash=${trash} trashReason=${trashReason ?? "-"} rotationCandidate=${rotationCandidate}`,
      );
      reports.push({
        strategyHash: hash,
        pair,
        mode: s.mode,
        apiState,
        balanceA: balA.toString(),
        balanceB: balB.toString(),
        allowanceOk,
        quoteOk,
        quotedOut: quotedOut.toString(),
        verdict,
        rotationCandidate,
        trash,
        trashReason,
        sharedCoverage,
        aiNote: null,
      });
    }
  }

  // AI classification (phase 2): single enclave call over ALL positions at once.
  // One call per tick by design (not per position) to bound billed usage.
  let aiNotes = new Map<string, string>();
  if (cfg.aiEnabled && reports.length > 0) {
    try {
      const lines = reports
        .map(
          (r) =>
            `${r.strategyHash} ${r.pair} ${r.verdict} balA=${r.balanceA} balB=${r.balanceB} trash=${r.trash}`,
        )
        .join("\n");
      runtime.log(
        `[watch] ai calling ${cfg.aiApiUrl} model=${cfg.aiModel} lines=${reports.length}`,
      );
      const note = await maybeAskAI(runtime, cfg, lines);
      runtime.log(`[watch] ai raw reply=${note}`);
      runtime.log(`[watch] ai raw reply chars=${(note ?? "").length}`);
      if (note) {
        const hashes = reports.map((r) => r.strategyHash.toLowerCase());
        const hashSet = new Set(hashes);
        let parsed = false;
        try {
          const arr = JSON.parse(note) as unknown;
          if (Array.isArray(arr)) {
            parsed = true;
            for (const e of arr) {
              const h = String(
                (e as { hash?: string })?.hash ?? "",
              ).toLowerCase();
              const lv = String(
                (e as { level?: string })?.level ?? "",
              ).toUpperCase();
              if (!h || (lv !== "LOW" && lv !== "MEDIUM" && lv !== "HIGH"))
                continue;
              if (hashSet.has(h)) {
                aiNotes.set(h, lv);
                continue;
              }
              if (/^0x[0-9a-f]{8}$/.test(h)) {
                const hit = hashes.find((x) => x.startsWith(h));
                if (hit) {
                  runtime.log(`[watch] ai hash fallback ${h} -> ${hit}`);
                  aiNotes.set(hit, lv);
                } else {
                  runtime.log(`[watch] ai hash skip no match for ${h}`);
                }
                continue;
              }
              runtime.log(`[watch] ai hash skip no exact match for ${h}`);
            }
          }
        } catch {}
        if (!parsed) {
          for (const line of note.split("\n")) {
            const m = line.match(/([0-9a-fx]{8,66})\s*:?\s*(LOW|MEDIUM|HIGH)/i);
            if (!m) continue;
            let kh = m[1].toLowerCase();
            if (!kh.startsWith("0x")) kh = "0x" + kh;
            const lv = m[2].toUpperCase();
            if (hashSet.has(kh)) {
              aiNotes.set(kh, lv);
              continue;
            }
            if (/^0x[0-9a-f]{8}$/.test(kh)) {
              const hit = hashes.find((x) => x.startsWith(kh));
              if (hit) {
                runtime.log(`[watch] ai hash fallback ${kh} -> ${hit}`);
                aiNotes.set(hit, lv);
              } else {
                runtime.log(`[watch] ai hash skip no match for ${kh}`);
              }
              continue;
            }
            runtime.log(`[watch] ai hash skip no exact match for ${kh}`);
          }
        }
        runtime.log(`[watch] ai classified ${aiNotes.size}/${reports.length}`);
      }
    } catch (e) {
      runtime.log(`[watch] ai failed (non-fatal): ${String(e).slice(0, 160)}`);
    }
  }
  for (const r of reports) {
    const n = aiNotes.get(r.strategyHash.toLowerCase());
    if (n) r.aiNote = n;
  }

  const summary = {
    makers: makers.length,
    positions: reports.length,
    aggressive: reports.filter((r) => r.mode === "aggressive").length,
    stable: reports.filter((r) => r.mode !== "aggressive").length,
    healthy: reports.filter((r) => r.verdict === "healthy").length,
    depleted: reports.filter((r) => r.verdict === "depleted").length,
    sideDepleted: reports.filter((r) => r.verdict === "side-depleted").length,
    oorSuspect: reports.filter((r) => r.verdict === "oor-suspect").length,
    thinAllowance: reports.filter((r) => r.verdict === "thin-allowance").length,
    unreadable: reports.filter((r) => r.verdict === "unreadable").length,
    trash: reports.filter((r) => r.trash).length,
    rotationCandidates: reports.filter((r) => r.rotationCandidate).length,
  };
  runtime.log(
    `[watch] summary makers=${summary.makers} positions=${summary.positions} ` +
      `aggressive=${summary.aggressive} stable=${summary.stable} ` +
      `healthy=${summary.healthy} depleted=${summary.depleted} side-depleted=${summary.sideDepleted} oor-suspect=${summary.oorSuspect} ` +
      `thin-allowance=${summary.thinAllowance} unreadable=${summary.unreadable} ` +
      `trash=${summary.trash} rotationCandidates=${summary.rotationCandidates}`,
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
