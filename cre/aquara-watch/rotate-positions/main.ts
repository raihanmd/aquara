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

// WASM-safe: no viem, no 1inch SDK, no Node built-ins. Bigint only, pure JS helpers.

export type Config = {
  schedule: string;
  makers: string[];
  apiBase: string;
  beDeployUrl: string;
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
  trashMinVolumeUsd: number;
  trashMaxApyPct: number | null;
  trashZeroVolumeBothWindows: boolean;
  demoForceTrashHashes: string[];
  demoTrashAllAggressive: boolean;
  maxRotationsPerDay: number;
  dailyGasCapUsd: number;
  minGainMultipleBps: number;
  gasCostUsd: number;
  estGainBpsOfQuoted: number;
  creApiKeySecretId: string;
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

interface RotateCandidate extends PositionReport {
  maker: string;
  tokenA: string;
  tokenB: string;
  expectedGainUsd: number;
  gasCostUsd: number;
  aiLevel: string | null;
}

interface RotateDecision {
  strategyHash: string;
  maker: string;
  pair: string;
  verdict: Verdict;
  trash: boolean;
  trashReason: string | null;
  aiLevel: string | null;
  expectedGainUsd: number;
  gasCostUsd: number;
  gainMultipleBps: number;
  wouldRotate: boolean;
  reason: string;
}

// In-memory daily counters. DON instances are ephemeral; this resets on cold start.
// Follow-up: persist to Redis/DB (e.g. Prisma agentDecision count per day) for
// cross-instance durability. Key = YYYY-MM-DD.
const dailyRotationCount = new Map<string, number>();
const dailyGasSpentUsd = new Map<string, number>();
let dailyKey = "";

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function resetDailyIfNeeded(): void {
  const k = todayKey();
  if (k !== dailyKey) {
    dailyKey = k;
    dailyRotationCount.clear();
    dailyGasSpentUsd.clear();
  }
}

// Scaled-integer gate: gain > 2x gas
// minGainMultipleBps = 20000 means 2.00x. Use 1e6 scaling to avoid float drift.
function passesGainGate(gainUsd: number, gasUsd: number, minBps: number): { pass: boolean; bps: number } {
  if (!(gasUsd > 0) || !(gainUsd > 0) || !isFinite(gainUsd) || !isFinite(gasUsd)) return { pass: false, bps: 0 };
  const gainScaled = BigInt(Math.floor(gainUsd * 1_000_000));
  const gasScaled = BigInt(Math.floor(gasUsd * 1_000_000));
  if (gasScaled === 0n) return { pass: false, bps: 0 };
  // bps = gain/gas * 10000
  const bps = Number((gainScaled * 10000n) / gasScaled);
  return { pass: bps >= minBps, bps };
}

// Hex helpers (WASM-safe, no viem)
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): `0x${string}` {
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

function pad32(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h.padStart(64, "0");
}

function addrToPadded(addr: string): string {
  return pad32(addr.toLowerCase());
}

function bytes32ToPadded(hash: string): string {
  return pad32(hash.toLowerCase());
}

function uint256ToPadded(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

// Real selectors ported from watch-positions (viem-derived, WASM-safe constants)
// RAW_BALANCES_ABI: rawBalances(address,address,bytes32,address) -> 0x6d58b4cc
// QUOTE_ABI: quote((address,uint256,bytes),address,address,uint256,bytes) -> 0x44aa5f14
// Multicall3 aggregate3((address,bool,bytes)[]) -> 0x82ad56cb
const SEL_RAW_BALANCES = "0x6d58b4cc";
const SEL_ALLOWANCE = "0xdd62ed3e";
const SEL_BALANCEOF = "0x70a08231";
const SEL_AGGREGATE3 = "0x82ad56cb";
const SEL_QUOTE = "0x44aa5f14";

// ABI shapes (for reference, not used via viem - hand-rolled encoding below)
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

const TAKER_TRAITS_DEFAULT = "0x00000000000000000000000000000000000000000041";

// Minimal ABI encoding without viem
function encodeRawBalances(maker: string, app: string, strategyHash: string, token: string): `0x${string}` {
  return `${SEL_RAW_BALANCES}${addrToPadded(maker)}${addrToPadded(app)}${bytes32ToPadded(strategyHash)}${addrToPadded(token)}` as `0x${string}`;
}

function encodeAllowance(owner: string, spender: string): `0x${string}` {
  return `${SEL_ALLOWANCE}${addrToPadded(owner)}${addrToPadded(spender)}` as `0x${string}`;
}

function encodeBalanceOf(account: string): `0x${string}` {
  return `${SEL_BALANCEOF}${addrToPadded(account)}` as `0x${string}`;
}

function encodeAggregate3(calls: Array<{ target: string; allowFailure: boolean; callData: string }>): `0x${string}` {
  let hex = SEL_AGGREGATE3.slice(2);
  hex += pad32("20"); // offset to array
  hex += pad32(calls.length.toString(16)); // length
  let offset = calls.length * 32;
  const callHexes: Array<{ offset: number; hex: string }> = [];
  for (const c of calls) {
    const cd = c.callData.startsWith("0x") ? c.callData.slice(2) : c.callData;
    const cdLen = cd.length / 2;
    const paddedLen = Math.ceil(cdLen / 32) * 32;
    const paddedCd = cd.padEnd(paddedLen * 2, "0");
    const encodedCd = pad32(cdLen.toString(16)) + paddedCd;
    const callHex = addrToPadded(c.target) + pad32(c.allowFailure ? "1" : "0") + pad32("60") + encodedCd;
    callHexes.push({ offset, hex: callHex });
    offset += callHex.length / 2;
  }
  for (const ch of callHexes) hex += pad32(ch.offset.toString(16));
  for (const ch of callHexes) hex += ch.hex;
  return `0x${hex}` as `0x${string}`;
}

function encodeQuote(
  maker: string,
  traits: bigint,
  orderData: string,
  tokenIn: string,
  tokenOut: string,
  amount: bigint,
  takerTraits: string,
): `0x${string}` {
  const orderDataHex = orderData.startsWith("0x") ? orderData.slice(2) : orderData;
  const orderDataLen = orderDataHex.length / 2;
  const orderDataPaddedLen = Math.ceil(orderDataLen / 32) * 32;
  const orderDataPadded = orderDataHex.padEnd(orderDataPaddedLen * 2, "0");
  const takerHex = takerTraits.startsWith("0x") ? takerTraits.slice(2) : takerTraits;
  const takerLen = takerHex.length / 2;
  const takerPaddedLen = Math.ceil(takerLen / 32) * 32;
  const takerPadded = takerHex.padEnd(takerPaddedLen * 2, "0");
  const orderTupleSize = 96 + 32 + orderDataPaddedLen;
  const takerOffset = 0xa0 + orderTupleSize;
  let hex = SEL_QUOTE.slice(2);
  hex += pad32("a0");
  hex += addrToPadded(tokenIn);
  hex += addrToPadded(tokenOut);
  hex += uint256ToPadded(amount);
  hex += pad32(takerOffset.toString(16));
  hex += addrToPadded(maker);
  hex += uint256ToPadded(traits);
  hex += pad32("60");
  hex += pad32(orderDataLen.toString(16));
  hex += orderDataPadded;
  hex += pad32(takerLen.toString(16));
  hex += takerPadded;
  return `0x${hex}` as `0x${string}`;
}

function decodeStrategyBytes(hex: string): { maker: string; traits: bigint; data: string } | null {
  try {
    const h = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (h.length < 64) return null;
    const offset = parseInt(h.slice(0, 64), 16);
    if (!Number.isSafeInteger(offset) || offset * 2 + 192 > h.length) return null;
    const tupleStart = offset * 2;
    const makerHex = h.slice(tupleStart, tupleStart + 64);
    const maker = `0x${makerHex.slice(24)}`;
    const traitsHex = h.slice(tupleStart + 64, tupleStart + 128);
    const traits = BigInt(`0x${traitsHex}`);
    const dataOffsetHex = h.slice(tupleStart + 128, tupleStart + 192);
    const dataOffset = parseInt(dataOffsetHex, 16);
    if (!Number.isSafeInteger(dataOffset)) return null;
    const dataStart = tupleStart + dataOffset * 2;
    if (dataStart + 64 > h.length) return null;
    const dataLenHex = h.slice(dataStart, dataStart + 64);
    const dataLen = parseInt(dataLenHex, 16);
    if (!Number.isSafeInteger(dataLen) || dataLen > 100000) return null;
    const dataHex = h.slice(dataStart + 64, dataStart + 64 + dataLen * 2);
    const data = `0x${dataHex}`;
    return { maker, traits, data };
  } catch {
    return null;
  }
}

function decodeUint256(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const last64 = h.slice(-64);
  if (!last64) return 0n;
  return BigInt(`0x${last64}`);
}

function decodeAggregate3(dataHex: string): Array<{ success: boolean; returnData: `0x${string}` }> {
  const h = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const w = (i: number): string => h.slice(i * 64, i * 64 + 64);
  const n = parseInt(w(1), 16);
  if (!Number.isSafeInteger(n) || n > 10000) throw new Error(`bad aggregate3 length ${n}`);
  const out: Array<{ success: boolean; returnData: `0x${string}` }> = [];
  for (let i = 0; i < n; i++) {
    const rel = parseInt(w(2 + i), 16) / 32;
    const abs = 2 + rel;
    const success = parseInt(w(abs), 16) !== 0;
    const dRel = parseInt(w(abs + 1), 16) / 32;
    const dAbs = Math.floor(abs + dRel);
    const dLen = parseInt(w(dAbs), 16);
    if (!Number.isSafeInteger(dLen) || dLen > h.length / 2) throw new Error("bad row bytes");
    out.push({ success, returnData: ("0x" + h.slice((dAbs + 1) * 64, (dAbs + 1) * 64 + dLen * 2)) as `0x${string}` });
  }
  return out;
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
          const dd = jj?.choices?.[0]?.delta?.content ?? jj?.choices?.[0]?.message?.content ?? "";
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

async function maybeAskAI(
  runtime: TeeRuntime<Config>,
  cfg: Config,
  summary: string,
): Promise<string | null> {
  if (!cfg.aiEnabled) return null;
  try {
    const probe = runtime.getSecret({ id: cfg.aiApiKeySecretId }).result().value;
    void probe;
  } catch (e) {
    throw new Error(`ai secret missing: ${cfg.aiApiKeySecretId} (${String(e).slice(0, 100)})`);
  }
  const confClient = new ConfidentialHTTPClient();
  const donAI = runtime as unknown as DonRuntime<unknown>;
  const resp = confClient
    .sendRequest(donAI, {
      vaultDonSecrets: [{ key: cfg.aiApiKeySecretId, owner: cfg.aiApiKeyOwner }],
      request: {
        url: cfg.aiApiUrl,
        method: "POST",
        bodyString: JSON.stringify({
          model: cfg.aiModel,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: `You classify Aqua liquidity position rotation urgency. Input lines look like: <strategyHash> <pair> <verdict> trash=<true|false> balA=<raw> balB=<raw>. Verdict meanings: healthy=in range and fillable; depleted=both balances zero; side-depleted=one side drained to zero; oor-suspect=out of range, quote reverted; thin-allowance=fillable but Aqua allowance too low; unreadable=chain read failed. Decide level by these rules in order: unreadable=>LOW; depleted or side-depleted=>HIGH; trash=true=>HIGH; oor-suspect=>MEDIUM; thin-allowance=>MEDIUM; healthy=>LOW. Reply ONLY a JSON array, no other text: [{"hash":"<full 66-char strategyHash exactly as in input>","level":"LOW|MEDIUM|HIGH"}]. Copy each hash exactly, never truncate.\n${summary}`,
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

export const onCronTrigger = async (runtime: TeeRuntime<Config>): Promise<string> => {
  const cfg = (runtime as unknown as { config: Config }).config;
  resetDailyIfNeeded();

  const trashMinVolumeUsd = typeof cfg.trashMinVolumeUsd === "number" && isFinite(cfg.trashMinVolumeUsd) ? cfg.trashMinVolumeUsd : 1.0;
  const trashMaxApyPct = typeof cfg.trashMaxApyPct === "number" && isFinite(cfg.trashMaxApyPct) ? cfg.trashMaxApyPct : null;
  const trashZeroVolumeBothWindows = typeof cfg.trashZeroVolumeBothWindows === "boolean" ? cfg.trashZeroVolumeBothWindows : true;
  const demoForceTrashHashes: string[] = Array.isArray(cfg.demoForceTrashHashes)
    ? cfg.demoForceTrashHashes.filter((s) => typeof s === "string")
    : [];
  const demoTrashAllAggressive = typeof cfg.demoTrashAllAggressive === "boolean" ? cfg.demoTrashAllAggressive : false;
  const demoForceSet = new Set(demoForceTrashHashes.map((h) => h.toLowerCase()));

  const maxRotationsPerDay = typeof cfg.maxRotationsPerDay === "number" && isFinite(cfg.maxRotationsPerDay) ? cfg.maxRotationsPerDay : 1;
  const dailyGasCapUsd = typeof cfg.dailyGasCapUsd === "number" && isFinite(cfg.dailyGasCapUsd) ? cfg.dailyGasCapUsd : 1.0;
  const minGainMultipleBps = typeof cfg.minGainMultipleBps === "number" && isFinite(cfg.minGainMultipleBps) ? cfg.minGainMultipleBps : 20000;
  const gasCostUsd = typeof cfg.gasCostUsd === "number" && isFinite(cfg.gasCostUsd) ? cfg.gasCostUsd : 0.08;
  const estGainBpsOfQuoted = typeof cfg.estGainBpsOfQuoted === "number" && isFinite(cfg.estGainBpsOfQuoted) ? cfg.estGainBpsOfQuoted : 50;

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

  // Vault secret probe - always required for POST to BE (simulate resolves via .env + secrets.yaml)
  let creApiKey: string | null = null;
  try {
    const v = runtime.getSecret({ id: cfg.creApiKeySecretId }).result().value as unknown;
    if (v instanceof Uint8Array) creApiKey = new TextDecoder().decode(v);
    else if (typeof v === "string") creApiKey = v;
    else if (v) creApiKey = String(v);
    if (!creApiKey) throw new Error("empty");
    runtime.log(`[rotate] CRE_API_KEY secret loaded (len=${creApiKey.length})`);
  } catch (e) {
    runtime.log(`[rotate] CRE_API_KEY secret missing: ${cfg.creApiKeySecretId} (${String(e).slice(0, 120)}) - POST will fail`);
  }

  let makers: string[] = [];
  try {
    const body = fetchJson(`${cfg.apiBase}/users?chainId=8453`) as unknown;
    const list = (Array.isArray(body) ? body : []) as unknown[];
    makers = list.filter((m) => typeof m === "string") as string[];
    runtime.log(`[rotate] makers from api=${makers.length}`);
  } catch (e) {
    runtime.log(`[rotate] users fetch failed, falling back to config: ${String(e).slice(0, 120)}`);
  }
  for (const extra of cfg.makers) {
    if (extra && !makers.some((m) => m.toLowerCase() === extra.toLowerCase())) makers.push(extra);
  }
  if (makers.length === 0) {
    runtime.log("[rotate] no makers - nothing to do");
    return JSON.stringify({ summary: { makers: 0, positions: 0, candidates: 0, wouldRotate: 0, executed: 0 }, decisions: [] });
  }

  const allDecisions: RotateDecision[] = [];
  let totalWouldRotate = 0;
  let totalExecuted = 0;

  for (const maker of makers) {
    runtime.log(`[rotate] maker=${maker}`);

    // Fetch strategies (DB rows) and live positions (Aqua API)
    let live: Array<{
      strategyHash: string;
      strategyBytes?: string;
      classification?: { state?: string };
      tokens: Array<{ address: string; symbol?: string; currentBalance?: { raw?: string }; initialBalance?: { raw?: string } }>;
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
          fees?: { last24h?: { apy?: unknown }; last7d?: { apy?: unknown }; total?: { apy?: unknown } };
        };
      }
    >();

    try {
      const body = fetchJson(`${cfg.apiBase}/strategies?maker=${maker}`) as unknown;
      const rows = (Array.isArray(body) ? body : []) as Array<{
        strategyHash: string;
        mode: string;
        strategyBytes?: string;
        tokenA?: string;
        tokenB?: string;
        performance?: {
          volume?: { last24h?: { usd?: unknown }; last7d?: { usd?: unknown } };
          fees?: { last24h?: { apy?: unknown }; last7d?: { apy?: unknown }; total?: { apy?: unknown } };
        };
      }>;
      for (const r of rows ?? []) {
        if (r?.strategyHash) dbRows.set(String(r.strategyHash).toLowerCase(), r);
      }
    } catch (e) {
      runtime.log(`[rotate] maker=${maker} strategies fetch failed: ${String(e).slice(0, 120)}`);
    }

    // Kill-switch: skip makers with no aggressive rows
    const aggressiveRows = [...dbRows.values()].filter((r) => r.mode === "aggressive");
    if (aggressiveRows.length === 0) {
      runtime.log(`[rotate] maker=${maker} kill-switch: no aggressive rows - skipping`);
      continue;
    }
    runtime.log(`[rotate] maker=${maker} aggressiveRows=${aggressiveRows.length} totalRows=${dbRows.size}`);

    try {
      const body = fetchJson(`${cfg.apiBase}/aqua/positions?maker=${maker}&chainIds=8453&limit=50`) as unknown;
      const items = (Array.isArray(body) ? body : (body as { items?: unknown[] }).items ?? []) as Array<{
        strategyHash: string;
        strategyBytes?: string;
        classification?: { state?: string };
        tokens: Array<{ address: string; symbol?: string; currentBalance?: { raw?: string }; initialBalance?: { raw?: string } }>;
      }>;
      live = items.filter((p) => p.strategyHash);
    } catch (e) {
      runtime.log(`[rotate] maker=${maker} positions fetch failed: ${String(e).slice(0, 160)}`);
      continue;
    }
    runtime.log(`[rotate] maker=${maker} live=${live.length} tracked=${dbRows.size}`);

    // EVM reads: balances, allowances, wallet balances (reuse watch multicall pattern, bigint only)
    const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    interface ReadRow {
      kind: "bal" | "allow" | "wallet";
      hash: string;
      token: string;
    }
    const batchRows: ReadRow[] = [];
    const uniqToks: string[] = [];
    for (const p of live) {
      const h = String(p.strategyHash ?? "").toLowerCase();
      const row = dbRows.get(h);
      const addrs = [
        ...new Set(
          [row?.tokenA, row?.tokenB, ...((p.tokens ?? []).map((t) => t.address))]
            .filter(Boolean)
            .map((a) => String(a).toLowerCase()),
        ),
      ].slice(0, 2);
      for (const a of addrs) {
        batchRows.push({ kind: "bal", hash: h, token: a });
        if (!uniqToks.includes(a)) uniqToks.push(a);
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

    const encodeRowCall = (r: ReadRow): `0x${string}` => {
      if (r.kind === "bal") return encodeRawBalances(maker, cfg.app, r.hash, r.token);
      if (r.kind === "allow") return encodeAllowance(maker, cfg.aquaRegistry);
      return encodeBalanceOf(maker);
    };
    const rowTarget = (r: ReadRow): string => (r.kind === "bal" ? cfg.aquaRegistry : r.token);

    try {
      const data = encodeAggregate3(
        batchRows.map((r) => ({
          target: rowTarget(r),
          allowFailure: true,
          callData: encodeRowCall(r),
        })),
      );
      const rawHex = bytesToHex(evmCall(MULTICALL3, data));
      const rets = decodeAggregate3(rawHex);
      if (!Array.isArray(rets) || rets.length !== batchRows.length) {
        throw new Error(`multicall shape mismatch rows=${batchRows.length} got=${Array.isArray(rets) ? rets.length : typeof rets}`);
      }
      rets.forEach((ret, k) => {
        const r = batchRows[k];
        if (!ret?.success) return;
        try {
          if (r.kind === "bal") {
            const bal = decodeUint256(ret.returnData);
            balMap.set(`${r.hash}:${r.token}`, bal);
          } else if (r.kind === "allow") {
            const alw = decodeUint256(ret.returnData);
            allowMap.set(r.token, alw > 0n);
          } else {
            const bal = decodeUint256(ret.returnData);
            walletMap.set(r.token, bal);
          }
        } catch {}
      });
      runtime.log(`[rotate] maker=${maker} multicall ok rows=${rets.length}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e ?? "");
      if (/limit|capability call limit|too many|rate/i.test(msg)) {
        infraDegraded = true;
        runtime.log(`[rotate] maker=${maker} multicall hit chain-read limit - degraded mode`);
      } else {
        runtime.log(`[rotate] maker=${maker} multicall failed: ${msg.slice(0, 200)} - falling back to individual reads`);
        for (const r of batchRows) {
          try {
            const one = encodeRowCall(r);
            const target = rowTarget(r);
            const ret = evmCall(target, one);
            const hex = bytesToHex(ret);
            if (r.kind === "bal") balMap.set(`${r.hash}:${r.token}`, decodeUint256(hex));
            else if (r.kind === "allow") allowMap.set(r.token, decodeUint256(hex) > 0n);
            else walletMap.set(r.token, decodeUint256(hex));
          } catch {}
        }
      }
    }

    // Build PositionReports (mirror watch verdict + trash logic)
    const reports: PositionReport[] = [];
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
        tokens: (p.tokens ?? []).map((t) => ({ address: t.address, symbol: t.symbol })),
        performance: row?.performance,
      };
      const apiState = (p.classification as { state?: string } | undefined)?.state ?? null;
      const fromRow = [s.tokenA, s.tokenB].filter(Boolean) as string[];
      const fromApi = (s.tokens ?? []).slice(0, 2);
      const toks =
        fromRow.length >= 2
          ? fromRow.map((a, k) => ({ address: a, symbol: fromApi[k]?.symbol }))
          : fromApi.map((t: { address: string; symbol?: string }) => ({ address: t.address, symbol: t.symbol }));
      if (toks.length < 2) continue;
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
      if (!infraDegraded && balA >= 0n && balB >= 0n && (balA > 0n || balB > 0n)) {
        try {
          const decoded = s.strategyBytes ? decodeStrategyBytes(s.strategyBytes) : null;
          if (!decoded) throw new Error("strategyBytes decode failed");
          const inFirst = balA > 0n;
          const tokenIn = (inFirst ? tA.address : tB.address) as `0x${string}`;
          const tokenOut = (inFirst ? tB.address : tA.address) as `0x${string}`;
          const amount = BigInt(cfg.probeAmountRaw);
          const data = encodeQuote(decoded.maker, decoded.traits, decoded.data, tokenIn, tokenOut, amount, TAKER_TRAITS_DEFAULT);
          const raw = evmCall(cfg.router, data);
          const hex = bytesToHex(raw);
          const outHex = `0x${hex.slice(2 + 64, 2 + 128)}` as `0x${string}`;
          quotedOut = decodeUint256(outHex);
          quoteOk = quotedOut > 0n;
        } catch {
          quoteOk = false;
        }
      }

      // side-depleted: initialBalance > 0 to current 0 (like watch)
      let sideDepleted = false;
      const hasInitialData = (p.tokens ?? []).some((t) => t.initialBalance?.raw != null && t.currentBalance?.raw != null);
      if (hasInitialData) {
        const initOf = new Map<string, string>();
        for (const t of p.tokens ?? []) {
          const a = String(t.address ?? "").toLowerCase();
          if (!a) continue;
          initOf.set(`${a}:cur`, String(t.currentBalance?.raw ?? ""));
          initOf.set(`${a}:ini`, String(t.initialBalance?.raw ?? ""));
        }
        sideDepleted = toks.some((t) => {
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
      }

      let verdict: Verdict;
      if (infraDegraded) verdict = "unreadable";
      else if (balA < 0n || balB < 0n) verdict = "unreadable";
      else if (balA === 0n && balB === 0n) verdict = "depleted";
      else if (sideDepleted) verdict = "side-depleted";
      else if (!quoteOk) verdict = "oor-suspect";
      else if (!allowanceOk) verdict = "thin-allowance";
      else verdict = "healthy";

      // Trash logic (mirror watch)
      let trash = false;
      let trashReason: string | null = null;
      const perf = s.performance;
      const v24 = perf?.volume?.last24h?.usd != null ? Number(perf.volume.last24h.usd) : null;
      const v7 = perf?.volume?.last7d?.usd != null ? Number(perf.volume.last7d.usd) : null;
      const apy = perf?.fees?.last24h?.apy != null ? Number(perf.fees.last24h.apy) : null;
      if (mode !== "aggressive") {
        trash = false;
      } else if (demoTrashAllAggressive) {
        trash = true;
        trashReason = "demo-all";
      } else if (demoForceSet.has(hash.toLowerCase())) {
        trash = true;
        trashReason = "demo-force";
      } else if (trashZeroVolumeBothWindows && v24 !== null && v7 !== null && v24 === 0 && v7 === 0) {
        trash = true;
        trashReason = "zero-volume-both-windows";
      } else if (v24 !== null && v24 < trashMinVolumeUsd) {
        trash = true;
        trashReason = "low-volume-24h";
      } else if (trashMaxApyPct !== null && apy !== null && apy < trashMaxApyPct) {
        trash = true;
        trashReason = "low-apy";
      }

      const rotationCandidate =
        mode === "aggressive" &&
        ((verdict === "oor-suspect" || verdict === "depleted" || verdict === "side-depleted" || trash) as boolean);

      reports.push({
        strategyHash: hash,
        pair,
        mode,
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
        sharedCoverage: [],
        aiNote: null,
      });
    }

    // AI classification (single-hit, ConfidentialHTTPClient) - full 66-char hashes
    let aiNotes = new Map<string, string>();
    if (cfg.aiEnabled && reports.length > 0) {
      try {
        const lines = reports.map((r) => `${r.strategyHash} ${r.pair} ${r.verdict} trash=${r.trash} balA=${r.balanceA} balB=${r.balanceB}`).join("\n");
        runtime.log(`[rotate] ai calling ${cfg.aiApiUrl} model=${cfg.aiModel} lines=${reports.length}`);
        const note = await maybeAskAI(runtime, cfg, lines);
        runtime.log(`[rotate] ai raw reply chars=${(note ?? "").length}`);
        if (note) {
          const hashes = reports.map((r) => r.strategyHash.toLowerCase());
          const fullHashSet = new Set(hashes);
          let parsed = false;
          try {
            const arr = JSON.parse(note) as unknown;
            if (Array.isArray(arr)) {
              parsed = true;
              for (const e of arr) {
                const h = String((e as { hash?: string })?.hash ?? "").toLowerCase();
                const lv = String((e as { level?: string })?.level ?? "").toUpperCase();
                if (!h || (lv !== "LOW" && lv !== "MEDIUM" && lv !== "HIGH")) continue;
                if (fullHashSet.has(h)) {
                  aiNotes.set(h, lv);
                } else {
                  // Fallback: truncated 10-char prefix mapping
                  const kh = h.replace(/^0x/, "");
                  const hit = hashes.find((x) => {
                    const xh = x.replace(/^0x/, "");
                    return xh.startsWith(kh) || kh.startsWith(xh);
                  });
                  if (hit) {
                    aiNotes.set(hit, lv);
                    runtime.log(`[rotate] ai fallback: mapped truncated ${h.slice(0, 10)} to full ${hit.slice(0, 10)}`);
                  }
                }
              }
            }
          } catch {}
          if (!parsed) {
            for (const line of note.split("\n")) {
              const m = line.match(/([0-9a-fx]{8,66})\s*:?\s*(LOW|MEDIUM|HIGH)/i);
              if (!m) continue;
              const rawH = m[1].toLowerCase();
              const kh = rawH.replace(/^0x/, "");
              const lv = m[2].toUpperCase();
              const fullH = rawH.startsWith("0x") ? rawH : `0x${rawH}`;
              if (fullHashSet.has(fullH)) {
                aiNotes.set(fullH, lv);
              } else {
                const hit = hashes.find((h) => {
                  const hh = h.replace(/^0x/, "");
                  return hh.startsWith(kh) || kh.startsWith(hh);
                });
                if (hit) {
                  aiNotes.set(hit, lv);
                  runtime.log(`[rotate] ai fallback: mapped truncated ${rawH.slice(0, 10)} to full ${hit.slice(0, 10)}`);
                }
              }
            }
          }
          runtime.log(`[rotate] ai classified ${aiNotes.size}/${reports.length}`);
        }
      } catch (e) {
        runtime.log(`[rotate] ai failed (non-fatal): ${String(e).slice(0, 160)}`);
      }
    }
    for (const r of reports) {
      const n = aiNotes.get(r.strategyHash.toLowerCase());
      if (n) r.aiNote = n;
    }

    // Filter candidates: aggressive AND (rotationCandidate OR trash) AND AI HIGH (when aiEnabled) AND gain>2x gas AND daily caps
    for (const r of reports) {
      const isAggressive = r.mode === "aggressive";
      const isCandidate = r.rotationCandidate || r.trash;
      const aiLevel = r.aiNote ?? null;
      const aiPass = !cfg.aiEnabled || aiLevel === "HIGH";

      // Gain/gas configurable: estimatedGainUsd = quotedOut * estGainBpsOfQuoted / 10000 converted to USD
      // Rough math: quotedOut is raw token amount (assume 6 decimals for USDC-like), convert to USD via 1e6 divisor, then apply bps
      // gasCostUsd from config (default 0.08 = Base ~0.00002 ETH * $4000)
      const quoted = BigInt(r.quotedOut || "0");
      const estimatedGainUsd = quoted > 0n ? (Number(quoted) / 1e6) * (estGainBpsOfQuoted / 10000) : 0.15;
      const { pass: gainPass, bps } = passesGainGate(estimatedGainUsd, gasCostUsd, minGainMultipleBps);

      const perPositionKey = `${todayKey()}:${r.strategyHash.toLowerCase()}`;
      const perPositionCount = dailyRotationCount.get(perPositionKey) ?? 0;
      const dailyGasTotal = dailyGasSpentUsd.get(todayKey()) ?? 0;

      let wouldRotate = false;
      let reason = "";

      if (!isAggressive) reason = "skip: not aggressive";
      else if (!isCandidate) reason = `skip: not candidate (rotationCandidate=${r.rotationCandidate} trash=${r.trash})`;
      else if (!aiPass) reason = `skip: AI not HIGH (aiEnabled=${cfg.aiEnabled} level=${aiLevel ?? "null"})`;
      else if (!gainPass) reason = `skip: gain gate fail gain=${estimatedGainUsd.toFixed(4)} gas=${gasCostUsd.toFixed(4)} bps=${bps} need=${minGainMultipleBps}`;
      else if (perPositionCount >= maxRotationsPerDay) reason = `skip: max ${maxRotationsPerDay}/day per position`;
      else if (dailyGasTotal + gasCostUsd > dailyGasCapUsd) reason = `skip: daily gas cap $${dailyGasCapUsd} would exceed (spent=${dailyGasTotal.toFixed(4)} + ${gasCostUsd})`;
      else {
        wouldRotate = true;
        reason = `candidate: gain=${estimatedGainUsd.toFixed(4)} gas=${gasCostUsd.toFixed(4)} bps=${bps} ai=${aiLevel ?? "n/a"}`;
      }

      const decision: RotateDecision = {
        strategyHash: r.strategyHash,
        maker,
        pair: r.pair,
        verdict: r.verdict,
        trash: r.trash,
        trashReason: r.trashReason,
        aiLevel,
        expectedGainUsd: estimatedGainUsd,
        gasCostUsd,
        gainMultipleBps: bps,
        wouldRotate,
        reason,
      };
      allDecisions.push(decision);

      if (wouldRotate) {
        totalWouldRotate++;
        dailyRotationCount.set(perPositionKey, perPositionCount + 1);
        dailyGasSpentUsd.set(todayKey(), dailyGasTotal + gasCostUsd);

        if (!creApiKey) {
          runtime.log(`[rotate] POST skipped: CRE_API_KEY missing for ${r.strategyHash.slice(0, 10)}`);
          decision.reason += " | POST skipped: missing CRE_API_KEY";
          decision.wouldRotate = false;
          continue;
        }
        try {
          const bodyStr = JSON.stringify({
            maker: maker.toLowerCase(),
            strategyHash: r.strategyHash,
            pair: r.pair,
            mode: r.mode,
            reason: `rotate: ${r.verdict} trash=${r.trash} ai=${aiLevel ?? "n/a"} gainBps=${bps}`,
          });
          const resp = http
            .sendRequest(runtime, {
              url: cfg.beDeployUrl,
              method: "POST",
              headers: { "Content-Type": "application/json", "x-api-key": creApiKey },
              body: new TextEncoder().encode(bodyStr),
            })
            .result();
          if (!ok(resp)) {
            runtime.log(`[rotate] POST failed hash=${r.strategyHash.slice(0, 10)} status=${resp.statusCode} body=${new TextDecoder().decode(resp.body).slice(0, 200)}`);
            decision.reason += ` | POST failed ${resp.statusCode}`;
          } else {
            runtime.log(`[rotate] POST ok hash=${r.strategyHash.slice(0, 10)} status=${resp.statusCode}`);
            totalExecuted++;
          }
        } catch (e) {
          runtime.log(`[rotate] POST error hash=${r.strategyHash.slice(0, 10)} err=${String(e).slice(0, 160)}`);
          decision.reason += ` | POST error ${String(e).slice(0, 80)}`;
        }
      } else {
        runtime.log(`[rotate] skip maker=${maker} hash=${r.strategyHash.slice(0, 10)} pair=${r.pair} reason=${reason}`);
      }
    }
  }

  const summary = {
    makers: makers.length,
    decisions: allDecisions.length,
    wouldRotate: totalWouldRotate,
    executed: totalExecuted,
    dailyGasCapUsd,
    maxRotationsPerDay,
    minGainMultipleBps,
    gasCostUsd,
    estGainBpsOfQuoted,
  };
  runtime.log(`[rotate] summary makers=${summary.makers} decisions=${summary.decisions} wouldRotate=${summary.wouldRotate} executed=${summary.executed}`);
  return JSON.stringify({ summary, decisions: allDecisions });
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
