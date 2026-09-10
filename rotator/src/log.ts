export type RotateDecision = "rotated" | "docked" | "skip" | "blocked" | "error" | "dry-run";

export interface RotateRecord {
  at: string;
  maker: string;
  strategyHash: string;
  pair: string;
  decision: RotateDecision;
  reason: string;
  verdict?: string;
  aiLevel?: string;
  txHash?: string;
  dryRun: boolean;
}

const RING_CAP = 50;
const ring: RotateRecord[] = [];

export function logRotate(rec: RotateRecord): void {
  ring.push(rec);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  const extra = [
    `verdict=${rec.verdict ?? "-"}`,
    rec.aiLevel ? `ai=${rec.aiLevel}` : "",
    rec.txHash ? `tx=${rec.txHash}` : "",
    `dryRun=${rec.dryRun}`,
  ]
    .filter(Boolean)
    .join(" ");
  console.log(
    `[rotate] ${rec.at} maker=${rec.maker.slice(0, 10)} hash=${rec.strategyHash.slice(0, 10)} pair=${rec.pair} decision=${rec.decision} reason=${rec.reason} ${extra}`,
  );
}

export function logInfo(msg: string, fields: Record<string, unknown> = {}): void {
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.log(`[rotator] ${msg}${extra ? ` ${extra}` : ""}`);
}

export function recentRotations(): RotateRecord[] {
  return [...ring].reverse();
}
