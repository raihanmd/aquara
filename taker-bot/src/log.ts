export type TickDecision = "fill" | "skip" | "blocked" | "error";

export interface TickRecord {
  at: string;
  pair: string;
  decision: TickDecision;
  reason: string;
  sizeUsd?: number;
  expectedOut?: string;
  quotedOut?: string;
  txHash?: string;
  gasUsed?: string;
  dryRun: boolean;
}

const RING_CAP = 50;
const ring: TickRecord[] = [];

function line(rec: TickRecord): string {
  const base = `[tick] ${rec.at} pair=${rec.pair} decision=${rec.decision} reason=${rec.reason}`;
  const extra = [
    rec.sizeUsd !== undefined ? `sizeUsd=${rec.sizeUsd}` : "",
    rec.expectedOut ? `expected=${rec.expectedOut}` : "",
    rec.quotedOut ? `quoted=${rec.quotedOut}` : "",
    rec.txHash ? `tx=${rec.txHash}` : "",
    rec.gasUsed ? `gas=${rec.gasUsed}` : "",
    `dryRun=${rec.dryRun}`,
  ]
    .filter(Boolean)
    .join(" ");
  return extra ? `${base} ${extra}` : base;
}

export function logTick(rec: TickRecord): void {
  ring.push(rec);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  console.log(line(rec));
  if (process.env.BOT_JSON_LOGS === "true") {
    console.log(JSON.stringify({ scope: "tick", ...rec }));
  }
}

export function logInfo(msg: string, fields: Record<string, unknown> = {}): void {
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.log(`[bot] ${msg}${extra ? ` ${extra}` : ""}`);
}

export function recentTicks(): TickRecord[] {
  return [...ring].reverse();
}
