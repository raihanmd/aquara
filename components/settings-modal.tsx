"use client";

import { useState } from "react";
import { SettingsIcon } from "lucide-react";
import { useAccount } from "wagmi";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useSettings, type RiskProfile } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";

const RISK_OPTIONS: { value: RiskProfile; label: string; desc: string }[] = [
  { value: "low", label: "Conservative", desc: "+/- 20% range" },
  { value: "medium", label: "Balanced", desc: "+/- 10% range" },
  { value: "high", label: "Aggressive", desc: "+/- 1% range" },
];

const COMING_SOON_OPTIONS = [
  { label: "Volatility Adaptive", desc: "Adjusts range based on pool volatility" },
  { label: "Autonomous Agent", desc: "AI-optimized range and timing" },
];

const SLIPPAGE_OPTIONS = [10, 30, 50, 100]; // bps

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const { address } = useAccount();
  const { settings, update } = useSettings(address);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border/40 bg-muted/30 p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
        title="Settings"
      >
        <SettingsIcon className="size-3" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agent Settings</DialogTitle>
            <DialogDescription>
              Configure how Aqua EZ manages your strategies
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 pt-2">
            {/* Risk Profile */}
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">
                Risk Profile
              </label>
              <div className="grid grid-cols-3 gap-2 mt-2">
                {RISK_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => update({ riskProfile: opt.value })}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left transition-all cursor-pointer",
                      settings.riskProfile === opt.value
                        ? "border-foreground/30 bg-foreground/[0.06]"
                        : "border-border/40 hover:border-border/60 hover:bg-muted/30"
                    )}
                  >
                    <div className="text-xs font-medium">{opt.label}</div>
                    <div className="text-[10px] text-muted-foreground/50 mt-0.5">{opt.desc}</div>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {COMING_SOON_OPTIONS.map((opt) => (
                  <div
                    key={opt.label}
                    className="rounded-lg border border-border/40 px-3 py-2.5 text-left opacity-40 cursor-not-allowed relative"
                  >
                    <div className="flex items-center gap-1.5">
                      <div className="text-xs font-medium">{opt.label}</div>
                      <span className="text-[9px] font-medium uppercase tracking-wider bg-muted/60 text-muted-foreground/60 px-1.5 py-0.5 rounded-full">
                        Soon
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/50 mt-0.5">{opt.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Max Slippage */}
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">
                Max Slippage
              </label>
              <div className="flex gap-2 mt-2">
                {SLIPPAGE_OPTIONS.map((bps) => (
                  <button
                    key={bps}
                    onClick={() => update({ maxSlippage: bps })}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs transition-all cursor-pointer",
                      settings.maxSlippage === bps
                        ? "border-foreground/30 bg-foreground/[0.06] text-foreground"
                        : "border-border/40 text-muted-foreground hover:border-border/60"
                    )}
                  >
                    {(bps / 100).toFixed(1)}%
                  </button>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
