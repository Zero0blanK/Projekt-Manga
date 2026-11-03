'use client';

import { useEffect } from 'react';
import { onRequestFailure } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { getSetting } from '@/lib/app-store';
import { queryClient } from '@/lib/query-client';
import {
  AUTO_OPEN_CHALLENGE_SETTING,
  CHALLENGE_REQUIRED,
  openSourceBrowser,
  sourceBrowserBridge,
  sourceIdFromPath,
  sourceSessionKey,
  type SourceBrowserResult,
} from '@/lib/source-browser';

/** Sources whose check window this app run already opened by itself. */
const opened = new Set<string>();

/**
 * On the desktop app, opens a source's own site in a hidden browser window as soon as one
 * of its requests is stopped by a browser check (Cloudflare), instead of waiting for the
 * reader to press "Open in browser". When the check lets the browser through on its own
 * the window closes; when it needs a click, the same window is shown automatically. Once
 * a session is saved, everything from that source loads again.
 *
 * Once per source per app run, so a reader who closes the window isn't asked again on
 * every request; the notice's button still opens it any time.
 */
export function SourceChallengeAutoOpen() {
  useEffect(() => {
    if (!sourceBrowserBridge()) return;

    function finish(sourceId: string, result: SourceBrowserResult) {
      toast({ description: result.message });
      if (!result.saved) return;
      void queryClient.invalidateQueries({ queryKey: sourceSessionKey(sourceId) });
      // Everything that failed on this source can load now.
      void queryClient.invalidateQueries({
        predicate: (query) => JSON.stringify(query.queryKey).includes(JSON.stringify(sourceId)),
      });
    }

    return onRequestFailure((failure) => {
      if (failure.code !== CHALLENGE_REQUIRED) return;
      if (getSetting(AUTO_OPEN_CHALLENGE_SETTING, true) === false) return;
      const sourceId = sourceIdFromPath(failure.path);
      if (!sourceId || opened.has(sourceId)) return;
      opened.add(sourceId);
      void openSourceBrowser(sourceId, { closeWhenPassed: true }).then(
        (result) => finish(sourceId, result),
        (error: unknown) =>
          toast({
            description: error instanceof Error ? error.message : 'Couldn’t open the source.',
          }),
      );
    });
  }, []);
  return null;
}
