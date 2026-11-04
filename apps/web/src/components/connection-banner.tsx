'use client';
import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { getHealth } from '@projekt-manga/api-client';
import { queryClient } from '@/lib/query-client';

const CHECK_INTERVAL_MS = 30_000;

function subscribeToConnection(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Says so when the library server stops answering or this device loses its connection. */
export function ConnectionBanner() {
  const online = useSyncExternalStore(
    subscribeToConnection,
    () => navigator.onLine,
    () => true,
  );
  const { isError: unreachable } = useQuery(
    {
      queryKey: ['connection-health'],
      queryFn: ({ signal }) => getHealth(signal),
      refetchInterval: CHECK_INTERVAL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      retry: 1,
    },
    queryClient,
  );
  if (online && !unreachable) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-border bg-popover/95 px-4 py-2 text-xs shadow-lg backdrop-blur"
    >
      <WifiOff size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      {unreachable ? (
        <span>Can&apos;t reach the library server. Retrying.</span>
      ) : (
        <span>
          You&apos;re offline. Sources need a connection, but{' '}
          <Link href="/downloads" className="text-primary hover:underline">
            downloaded chapters
          </Link>{' '}
          still open.
        </span>
      )}
    </div>
  );
}
