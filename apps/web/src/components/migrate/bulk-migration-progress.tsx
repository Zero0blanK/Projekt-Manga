'use client';

import Link from 'next/link';
import { Progress } from '@/components/ui/progress';

/** The body of the bulk migration's progress toast. */
export function BulkMigrationProgress({ done, total }: { done: number; total: number }) {
  return (
    <span className="mt-1 block w-64 max-w-full space-y-1.5">
      <Progress value={total ? (done / total) * 100 : 0} aria-label="Progress" />
      <span className="flex items-center justify-between gap-3 text-xs">
        <span>
          {done} of {total}
        </span>
        <Link href="/migrate" className="font-medium text-primary hover:underline">
          View
        </Link>
      </span>
    </span>
  );
}
