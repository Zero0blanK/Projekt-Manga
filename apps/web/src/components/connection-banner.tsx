'use client';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { getHealth } from '@projekt-manga/api-client';
import { queryClient, queryKeys } from '@/lib/query-client';

const CHECK_INTERVAL_MS = 30_000;
/**
 * While the server can't be reached. It is often only starting (the app opened first, or
 * the server is restarting), and waiting the full interval left the app "offline" for up to
 * 30 seconds after it was back.
 */
const RECHECK_INTERVAL_MS = 3_000;

function subscribeToConnection(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * Once the server answers again, loads again whatever failed while it couldn't be reached
 * (the library, the session, the page's own data), so nothing stays on its error state or
 * on the device's saved copy until the next visit.
 */
function useReloadFailedOnReconnect(unreachable: boolean) {
  const wasUnreachable = useRef(false);
  useEffect(() => {
    if (unreachable) {
      wasUnreachable.current = true;
      return;
    }
    if (!wasUnreachable.current) return;
    wasUnreachable.current = false;
    void queryClient.refetchQueries({
      type: 'active',
      predicate: (query) =>
        query.state.status === 'error' && query.queryKey[0] !== 'connection-health',
    });
  }, [unreachable]);
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
      refetchInterval: (query) =>
        query.state.status === 'error' ? RECHECK_INTERVAL_MS : CHECK_INTERVAL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      retry: 1,
    },
    queryClient,
  );
  useReloadFailedOnReconnect(unreachable);
  // With the server unreachable, a library on screen came from this device: the saved copy
  // (lib/offline-library.ts) or the offline worker's cache (public/sw.js).
  const saved = (queryClient.getQueryData<unknown[]>(queryKeys.mangaLibrary)?.length ?? 0) > 0;
  if (online && !unreachable) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-border bg-popover/95 px-4 py-2 text-xs shadow-lg backdrop-blur"
    >
      <WifiOff size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      {unreachable ? (
        <span>
          {saved
            ? "Can't reach the library server. Showing your library as saved on this device. Reading progress is kept here and sent once it's back."
            : "Can't reach the library server. Retrying."}
        </span>
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
