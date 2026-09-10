"use client";

import { BotIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAgentDecisions } from "@/hooks/use-agent-decisions";

const ACTION_STYLE: Record<string, string> = {
  dock: "bg-destructive/10 text-destructive",
  watch: "bg-warning text-warning-foreground",
  reviewFee: "bg-warning text-warning-foreground",
  ship: "bg-primary/10 text-primary",
  keep: "bg-muted text-muted-foreground",
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AgentActivity({ maker }: { maker?: string | null }) {
  const { data: rows } = useAgentDecisions(maker);

  if (!maker || rows.length === 0) return null;

  return (
    <section aria-labelledby="agent-activity-heading">
      <div className="flex items-center gap-2 mb-3">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <BotIcon className="size-3.5" aria-hidden="true" />
        </span>
        <h2
          id="agent-activity-heading"
          className="text-sm font-semibold tracking-tight"
        >
          Agent activity
        </h2>
      </div>

      <Card className="rounded-xl border border-border/50 bg-card px-4 pt-2 pb-2">
        <ul className="divide-y divide-border/40">
          {rows.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2.5">
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                  ACTION_STYLE[d.action] ?? ACTION_STYLE.keep
                )}
              >
                {d.action}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">
                  {d.pair}{" "}
                  {d.txHash && (
                    <a
                      href={`https://basescan.org/tx/${d.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={d.txHash}
                      className="ml-1 font-mono font-normal text-muted-foreground/70 underline decoration-dotted underline-offset-2 hover:text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {d.txHash.slice(0, 10)}…
                    </a>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {d.reason}
                </div>
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground/60">
                {timeAgo(d.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
