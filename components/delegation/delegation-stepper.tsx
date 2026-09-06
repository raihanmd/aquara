"use client";

import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircleIcon,
  ShieldCheckIcon,
  LoaderIcon,
  ExternalLinkIcon,
  AlertCircleIcon,
  KeyRoundIcon,
  ShieldIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDelegation } from "@/hooks/use-delegation";
import { cn } from "@/lib/utils";

type Step = 0 | 1 | 2;

interface DelegationStepperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "all" for all positions, or array of specific position tokenIds */
  mode: "all" | string[];
}

const STEPS = [
  {
    title: "Prepare Delegation",
    icon: ShieldIcon,
  },
  {
    title: "Sign Transaction",
    icon: KeyRoundIcon,
  },
  {
    title: "Delegation Active",
    icon: SparklesIcon,
  },
];

export function DelegationStepper({
  open,
  onOpenChange,
  mode,
}: DelegationStepperProps) {
  const [step, setStep] = useState<Step>(0);
  const { agentAddress, isSubmitting, error, txHash, delegate, status } =
    useDelegation();

  const handleDelegate = async () => {
    setStep(1);
    const positionIds = mode === "all" ? undefined : mode;
    const success = await delegate(positionIds);
    if (success) {
      setStep(2);
    }
  };

  const handleClose = () => {
    setStep(0);
    onOpenChange(false);
  };

  const isSpecific = mode !== "all";
  const modeLabel = isSpecific
    ? `${(mode as string[]).length} position${(mode as string[]).length !== 1 ? "s" : ""}`
    : "all positions";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5" />
            Delegate to Aqua EZ
          </DialogTitle>
          <DialogDescription>
            Grant Aqua EZ permission to manage {modeLabel} via Calibur.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center justify-between px-2">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const isActive = step === i;
            const isComplete = step > i;
            return (
              <div key={s.title} className="flex items-center gap-2">
                {i > 0 && (
                  <div
                    className={cn(
                      "h-px w-8 sm:w-12 transition-colors duration-300",
                      isComplete || isActive
                        ? "bg-foreground/30"
                        : "bg-border/50",
                    )}
                  />
                )}
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full border transition-all duration-300",
                      isComplete
                        ? "border-green-500/30 bg-green-500/10 text-green-500"
                        : isActive
                          ? "border-foreground/20 bg-foreground/5 text-foreground"
                          : "border-border/50 bg-card text-muted-foreground/40",
                    )}
                  >
                    {isComplete ? (
                      <CheckCircleIcon className="size-4" />
                    ) : (
                      <Icon className="size-3.5" />
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-[10px] font-medium transition-colors hidden sm:block",
                      isActive
                        ? "text-foreground"
                        : isComplete
                          ? "text-green-500/70"
                          : "text-muted-foreground/40",
                    )}
                  >
                    {s.title}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <AnimatePresence mode="wait">
          {step === 0 && (
            <StepContent key="step-0">
              <div className="space-y-4">
                <div className="rounded-xl border border-border/50 bg-card/50 p-4 space-y-3">
                  <h4 className="text-sm font-medium">
                    What happens when you delegate?
                  </h4>
                  <ul className="space-y-2 text-[13px] text-muted-foreground">
                    <li className="flex gap-2">
                      <span className="text-foreground/60 shrink-0">1.</span>
                      Your wallet delegates to a smart account (Calibur via
                      EIP-7702)
                    </li>
                    <li className="flex gap-2">
                      <span className="text-foreground/60 shrink-0">2.</span>
                      Aqua EZ agent key is registered with restricted
                      permissions
                    </li>
                    <li className="flex gap-2">
                      <span className="text-foreground/60 shrink-0">3.</span>
                      Agent can only call Aqua ship/dock + approvals
                    </li>
                  </ul>
                </div>

                <div className="rounded-xl border border-border/50 bg-card/50 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      Agent Address
                    </span>
                    {agentAddress ? (
                      <code className="text-xs font-mono text-foreground/70">
                        {agentAddress.slice(0, 6)}...{agentAddress.slice(-4)}
                      </code>
                    ) : (
                      <span className="text-xs text-muted-foreground/50">
                        Loading...
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Scope</span>
                    <span className="text-xs text-foreground/70 capitalize">
                      {mode === "all"
                        ? "All positions"
                        : `${(mode as string[]).length} selected`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      Expiry
                    </span>
                    <span className="text-xs text-foreground/70">30 days</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Guard</span>
                    <span className="text-xs text-foreground/70">
                      GuardedExecutorHook
                    </span>
                  </div>
                </div>

                {status === "delegated" && (
                  <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2">
                    <CheckCircleIcon className="size-4 text-green-500" />
                    <span className="text-xs text-green-500">
                      Already delegated! You can re-delegate to update settings.
                    </span>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={handleDelegate}
                  disabled={!agentAddress}
                >
                  Continue to Sign
                </Button>
              </div>
            </StepContent>
          )}

          {step === 1 && (
            <StepContent key="step-1">
              <div className="flex flex-col items-center gap-4 py-6">
                {isSubmitting ? (
                  <>
                    <div className="relative">
                      <LoaderIcon className="size-10 text-foreground/60 animate-spin" />
                    </div>
                    <div className="text-center space-y-1">
                      <p className="text-sm font-medium">
                        Waiting for signature...
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Please confirm the transaction in your wallet
                      </p>
                    </div>
                  </>
                ) : error ? (
                  <>
                    <AlertCircleIcon className="size-10 text-red-400" />
                    <div className="text-center space-y-1">
                      <p className="text-sm font-medium text-red-400">
                        Transaction Failed
                      </p>
                      <p className="text-xs text-muted-foreground max-w-xs">
                        {error}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setStep(0);
                      }}
                    >
                      Try Again
                    </Button>
                  </>
                ) : null}
              </div>
            </StepContent>
          )}

          {step === 2 && (
            <StepContent key="step-2">
              <div className="flex flex-col items-center gap-4 py-6">
                <motion.div
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", duration: 0.5 }}
                >
                  <CheckCircleIcon className="size-12 text-green-500" />
                </motion.div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium">Delegation Active</p>
                  <p className="text-xs text-muted-foreground">
                    Aqua EZ is now monitoring and will manage {modeLabel}.
                  </p>
                </div>

                {txHash && (
                  <a
                    href={`https://basescan.org/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View on Basescan
                    <ExternalLinkIcon className="size-3" />
                  </a>
                )}

                <Button className="w-full" onClick={handleClose}>
                  Done
                </Button>
              </div>
            </StepContent>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

function StepContent({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.div>
  );
}
