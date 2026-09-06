import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function CardSkeleton() {
  return (
    <Card className="flex flex-col gap-0 px-4 pt-3 pb-3 rounded-xl border border-border/50 bg-card">
      <div className="flex items-center gap-2 mb-2">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-4 w-28 rounded-md" />
      </div>
      <div className="grid grid-cols-3 gap-2 mb-2">
        <Skeleton className="h-9 rounded-md" />
        <Skeleton className="h-9 rounded-md" />
        <Skeleton className="h-9 rounded-md" />
      </div>
      <div className="mt-auto h-1.5">
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      <div className="mt-2">
        <Skeleton className="h-8 w-full rounded-md" />
      </div>
    </Card>
  );
}
