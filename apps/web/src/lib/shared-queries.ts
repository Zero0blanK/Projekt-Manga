'use client';

import { useQuery } from '@tanstack/react-query';
import { getAllDownloads, getHistory, type PublicUser } from '@projekt-manga/api-client';
import { queryClient, queryKeys } from '@/lib/query-client';
import { useCurrentUser } from '@/lib/session-resource';

/**
 * The two long lists many screens read: one cached copy each, per account, instead of every
 * screen downloading its own. Reading and download writes invalidate them, and so do changes
 * from another device, through LibraryLiveUpdates.
 *
 * No retries: each screen shows a failure with its own retry button.
 */
const FRESH_FOR_MS = 30_000;

type Owner = string | null;

const historyQuery = (owner: Owner) => ({
  queryKey: [...queryKeys.history, owner],
  queryFn: ({ signal }: { signal: AbortSignal }) => getHistory(signal),
  retry: false,
});

const downloadsQuery = (owner: Owner) => ({
  queryKey: [...queryKeys.downloads, owner],
  queryFn: ({ signal }: { signal: AbortSignal }) => getAllDownloads(signal),
  retry: false,
});

/** The signed-in account, for code outside React. */
const currentOwner = (): Owner =>
  queryClient.getQueryData<PublicUser | null>(queryKeys.session)?.id ?? null;

export function useHistory({ enabled = true }: { enabled?: boolean } = {}) {
  const { user, loading } = useCurrentUser();
  return useQuery(
    {
      ...historyQuery(user?.id ?? null),
      staleTime: FRESH_FOR_MS,
      enabled: enabled && !loading,
    },
    queryClient,
  );
}

export function useDownloads({ enabled = true }: { enabled?: boolean } = {}) {
  const { user, loading } = useCurrentUser();
  return useQuery(
    {
      ...downloadsQuery(user?.id ?? null),
      staleTime: FRESH_FOR_MS,
      enabled: enabled && !loading,
    },
    queryClient,
  );
}

/** For code acting on the answer, such as what's already queued: always asks the server,
 * sharing a request in flight, and leaves the answer for the screens above. */
export const fetchHistory = (owner: Owner = currentOwner()) =>
  queryClient.fetchQuery({ ...historyQuery(owner), staleTime: 0 });

export const fetchDownloads = (owner: Owner = currentOwner()) =>
  queryClient.fetchQuery({ ...downloadsQuery(owner), staleTime: 0 });

export const invalidateHistory = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.history });

export const invalidateDownloads = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.downloads });
