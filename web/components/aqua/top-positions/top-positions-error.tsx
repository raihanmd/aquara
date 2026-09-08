import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type ErrorStateProps = {
  message: string;
  onRetry?: () => void;
};

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <Card
      role="alert"
      className="col-span-full flex flex-col items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 px-6 py-8 text-center gap-0"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 mb-3">
        <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-medium text-destructive">
        Failed to load strategies
      </h3>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{message}</p>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="mt-4 gap-1.5"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Try again
        </Button>
      )}
    </Card>
  );
}
