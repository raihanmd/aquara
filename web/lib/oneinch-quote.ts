import type { Address, Hex } from "viem";
import { pace } from "./aqua-api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SwapQuoteTx {
  to: Address;
  data: Hex;
  value: bigint;
  dstAmount: bigint;
}

let diag = "";
export function lastQuoteDiag(): string {
  return diag;
}

function rateLimitCfg(): { maxAttempts: number; baseMs: number } {
  const isDev = process.env.NODE_ENV !== "production";
  return {
    maxAttempts: Math.max(
      1,
      Number(process.env.QUOTE_RETRY_ATTEMPTS ?? (isDev ? 8 : 5)) || 5,
    ),
    baseMs: Math.max(
      0,
      Number(process.env.QUOTE_RETRY_BASE_MS ?? (isDev ? 3000 : 1500)) || 1500,
    ),
  };
}

async function callOneInch(
  apiKey: string,
  endpoint: "swap" | "quote",
  params: Record<string, string>,
): Promise<{ res: Response; json: unknown } | null> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://api.1inch.com/swap/v6.1/8453/${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let desc = "";
    try {
      desc = (JSON.parse(text) as { description?: string })?.description || "";
    } catch {}
    return { res, json: { _http: res.status, _desc: desc, _text: text.slice(0, 120) } };
  }
  try {
    return { res, json: await res.json() };
  } catch {
    return null;
  }
}

function outOf(json: unknown): bigint | null {
  const j = json as { dstAmount?: string; toAmount?: string; toTokenAmount?: string };
  const raw = j?.dstAmount ?? j?.toAmount ?? j?.toTokenAmount ?? null;
  if (raw === null || raw === undefined) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Single shared 1inch quoter for web deploy AND rotator merge. Same pacing,
 * same retries, same slippage handling, same diagnostics - behavior cannot
 * drift between the two callers by construction.
 */
export async function quoteSwapExact(args: {
  apiKey: string;
  src: string;
  dst: string;
  amount: bigint;
  from: string;
  slippage?: number;
}): Promise<SwapQuoteTx | null> {
  const { apiKey, src, dst, amount, from } = args;
  const slippage = args.slippage ?? 0.5;
  const { maxAttempts, baseMs } = rateLimitCfg();
  diag = "";
  for (let attempt = 0; ; attempt++) {
    await pace();
    let out: Awaited<ReturnType<typeof callOneInch>>;
    try {
      out = await callOneInch(apiKey, "swap", {
        src,
        dst,
        amount: amount.toString(),
        from,
        slippage: String(slippage),
      });
    } catch {
      diag = "network error";
      return null;
    }
    if (!out) {
      diag = "empty response";
      return null;
    }
    const { res, json } = out;
    if (!res.ok) {
      const j = json as { _http?: number; _desc?: string; _text?: string };
      // Approval landing mid-flow: wait and retry like the dialog path.
      if (j._desc && /allowance/i.test(j._desc) && attempt < 4) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt + 1 < maxAttempts) {
        await sleep(baseMs * (attempt + 1));
        continue;
      }
      diag = j._desc || `Swap quote failed (${res.status}${attempt > 0 ? ` after ${attempt + 1} tries` : ""})`;
      return null;
    }
    const j = json as { tx?: { to?: string; data?: string; value?: string } };
    if (!j?.tx?.to || !j?.tx?.data) {
      diag = `empty-tx ${JSON.stringify(json).slice(0, 120)}`;
      return null;
    }
    return {
      to: j.tx.to as Address,
      data: j.tx.data as Hex,
      value: BigInt(j.tx.value ?? 0),
      dstAmount: outOf(json) ?? 0n,
    };
  }
}

/** Allowance-free route check (/quote needs no approval). Read-only. */
export async function quoteOnly(args: {
  apiKey: string;
  src: string;
  dst: string;
  amount: bigint;
}): Promise<{ dstAmount: bigint } | null> {
  diag = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    await pace();
    let out: Awaited<ReturnType<typeof callOneInch>>;
    try {
      out = await callOneInch(args.apiKey, "quote", {
        src: args.src,
        dst: args.dst,
        amount: args.amount.toString(),
      });
    } catch {
      diag = "network error";
      continue;
    }
    if (!out) {
      diag = "empty response";
      continue;
    }
    const { res, json } = out;
    if (!res.ok) {
      const j = json as { _http?: number; _desc?: string };
      if ((res.status === 429 || res.status === 502 || res.status === 503)) continue;
      diag = `${res.status} ${(j._desc || "").slice(0, 100)}`;
      return null;
    }
    const amt = outOf(json);
    if (amt === null) {
      diag = "no amount in quote";
      return null;
    }
    return { dstAmount: amt };
  }
  if (!diag) diag = "quote retries exhausted";
  return null;
}
