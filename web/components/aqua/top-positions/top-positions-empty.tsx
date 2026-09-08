import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type EmptyStateProps = {
  onRetry?: () => void;
};

export function EmptyState({ onRetry }: EmptyStateProps) {
  return (
    <Card className="col-span-full flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-card/40 px-6 py-10 text-center gap-0">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted mb-3">
        <Sparkles
          className="size-5 text-muted-foreground/50"
          aria-hidden="true"
        />
      </div>
      <h3 className="text-sm font-medium">No strategies found</h3>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        No top strategies match your current filters. Try adjusting the chain or
        sort option.
      </p>
      {onRetry && (
        <Button
          variant="default"
          size="sm"
          onClick={onRetry}
          className="mt-4"
        >
          Reset filters
        </Button>
      )}
    </Card>
  );
}
