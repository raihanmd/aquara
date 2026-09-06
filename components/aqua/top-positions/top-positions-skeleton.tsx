import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function CardSkeleton() {
  return (
    <Card className="flex flex-col gap-0 p-4 rounded-xl border border-border/50 bg-card min-h-[188px]">
      <div className="flex items-center gap-3 mb-3">
        <Skeleton className="size-6 rounded-full" />
        <div className="flex -space-x-1">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="size-5 rounded-full" />
        </div>
        <Skeleton className="h-4 w-24 rounded-md" />
        <Skeleton className="ml-auto h-5 w-12 rounded-md" />
      </div>
      <div className="flex justify-between mb-4">
        <div className="space-y-2">
          <Skeleton className="h-3 w-12 rounded" />
          <Skeleton className="h-5 w-16 rounded" />
        </div>
        <div className="space-y-2 flex flex-col items-end">
          <Skeleton className="h-3 w-16 rounded" />
          <Skeleton className="h-3 w-12 rounded" />
        </div>
      </div>
      <Skeleton className="h-3 w-32 rounded mb-3" />
      <div className="mt-auto flex gap-2">
        <Skeleton className="h-8 flex-1 rounded-md" />
        <Skeleton className="h-8 w-16 rounded-md" />
      </div>
    </Card>
  );
}
