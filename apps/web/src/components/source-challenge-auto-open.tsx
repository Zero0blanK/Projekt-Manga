'use client';

import { useEffect } from 'react';
import { getSourceHealth, onRequestFailure, type SourceHealth } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { getSetting } from '@/lib/app-store';
import {
  AUTO_OPEN_CHALLENGE_SETTING,
  CHALLENGE_REQUIRED,
  sourceIdFromPath,
} from '@/lib/source-browser';
import { canCheckSources, getSourceCheck, startSourceCheck } from '@/lib/source-check';

/** How often source health is read for checks met in the background. */
const HEALTH_POLL_MS = 60_000;

/**
 * On the desktop app, passes a source's browser check (Cloudflare) in the background as
 * soon as the source asks for one, instead of waiting for the reader to press "Open in
 * browser" or paste a cookie. The check runs in a hidden window of the source's own site
 * (lib/source-check.ts); the window only shows if the check needs a click.
 *
 * Two ways in: a request from this window failing on the check, and source health, which
 * also records checks met where no window was looking: a library update or a download.
 * Clearances expire, so a source is checked again whenever it asks again, but a check that
 * failed is left alone for a while rather than retried in a loop.
 */
export function SourceChallengeAutoOpen() {
  useEffect(() => {
    if (!canCheckSources()) return;
    const enabled = () => getSetting(AUTO_OPEN_CHALLENGE_SETTING, true) !== false;

    const check = (sourceId: string) => {
      if (!enabled()) return;
      const run = startSourceCheck(sourceId, { auto: true });
      void run?.then((state) => {
        if (state.status === 'passed' || state.status === 'failed') {
          toast({ description: state.message });
        }
      });
    };

    const stopFailures = onRequestFailure((failure) => {
      if (failure.code !== CHALLENGE_REQUIRED) return;
      const sourceId = sourceIdFromPath(failure.path);
      if (sourceId) check(sourceId);
    });

    /** A check met since this source's last check ended, by browsing or updating. */
    const challengedSince = (health: SourceHealth): boolean => {
      const previous = getSourceCheck(health.sourceId);
      const since = previous.status === 'passed' || previous.status === 'failed' ? previous.at : 0;
      return [health.browse, health.update].some(
        (operation) =>
          operation?.lastErrorCode === CHALLENGE_REQUIRED &&
          Date.parse(operation.lastAttemptAt) > since,
      );
    };

    let stopped = false;
    const readHealth = () => {
      if (!enabled()) return;
      getSourceHealth()
        .then((sources) => {
          if (stopped) return;
          for (const health of sources) if (challengedSince(health)) check(health.sourceId);
        })
        // Quiet: this is a background look, and the next one may answer.
        .catch(() => undefined);
    };
    readHealth();
    const timer = setInterval(readHealth, HEALTH_POLL_MS);

    return () => {
      stopped = true;
      stopFailures();
      clearInterval(timer);
    };
  }, []);
  return null;
}
