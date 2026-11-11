'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSourceBrowserSession } from '@projekt-manga/api-client';
import { Loader2, ShieldQuestion } from 'lucide-react';
import { getSetting } from '@/lib/app-store';
import { AUTO_OPEN_CHALLENGE_SETTING, sourceSessionKey } from '@/lib/source-browser';
import {
  canCheckSources,
  onSourceCheckPassed,
  startSourceCheck,
  useSourceCheck,
} from '@/lib/source-check';
import { useSources } from '@/lib/library-store';
import { SourceSessionManager } from './source-session-manager';

/**
 * Shown where a source answered with a browser check (Cloudflare).
 *
 * On the desktop app there is nothing to press: the check is passed in the background
 * (lib/source-check.ts) and whatever failed is retried when it passes. The reader is only
 * asked for something when the check needs them, in the window that opens by itself, or
 * when it failed. Pasting a session from another browser stays available as a fallback,
 * and is the way in a plain browser, which can't run the check for the server.
 */
export function SourceChallengeNotice({
  sourceId,
  sourceName,
  onPassed,
  compact = false,
}: {
  sourceId: string;
  sourceName: string;
  /** Called once the check has passed and its session is saved — usually a retry. */
  onPassed?: () => void;
  compact?: boolean;
}) {
  // Read after mount: the bridge only exists in the desktop renderer, and the server
  // render must match the first client render.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(canCheckSources()), []);
  const check = useSourceCheck(sourceId);
  const siteUrl = useSources().sources.find((source) => source.id === sourceId)?.base_url;
  const { data: session } = useQuery({
    queryKey: sourceSessionKey(sourceId),
    queryFn: ({ signal }) => getSourceBrowserSession(sourceId, signal),
    retry: false,
  });
  const hasSession = (session?.cookies.length ?? 0) > 0;
  const savedSessionHint = hasSession
    ? ' A session is already saved, but the site is asking again — it may have expired, or this server may reach the site from a different network than the browser that earned it.'
    : '';

  // Start the check if nothing has yet: this notice can be the first to see the source ask.
  useEffect(() => {
    if (!desktop || getSetting(AUTO_OPEN_CHALLENGE_SETTING, true) === false) return;
    void startSourceCheck(sourceId, { auto: true });
  }, [desktop, sourceId]);

  useEffect(
    () => (onPassed ? onSourceCheckPassed(sourceId, onPassed) : undefined),
    [sourceId, onPassed],
  );

  const tryAgain = () => void startSourceCheck(sourceId, { auto: false });
  const busy = check.status === 'checking' || check.status === 'needs-you';

  const manual = siteUrl ? (
    <SourceSessionManager
      sourceId={sourceId}
      sourceName={sourceName}
      siteUrl={siteUrl}
      onSaved={onPassed}
    />
  ) : null;

  return (
    <div
      className={compact ? 'mt-2 text-xs' : 'mx-auto mt-3 max-w-md text-xs'}
      role="status"
      aria-live="polite"
    >
      {desktop ? (
        <>
          {check.status === 'checking' && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Passing {sourceName}&apos;s browser check in the background…
            </p>
          )}
          {check.status === 'needs-you' && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {sourceName}&apos;s check needs you: finish it in the window that opened. It closes by
              itself once you&apos;re through.
            </p>
          )}
          {check.status === 'passed' && (
            <p className="text-muted-foreground">Passed {sourceName}&apos;s browser check.</p>
          )}
          {(check.status === 'idle' || check.status === 'failed') && (
            <>
              <p className="text-muted-foreground">
                {check.status === 'failed' ? check.message : `${sourceName} wants a browser check.`}
              </p>
              <button
                type="button"
                onClick={tryAgain}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 font-medium text-foreground transition hover:bg-accent"
              >
                <ShieldQuestion className="h-3.5 w-3.5" aria-hidden />
                {check.status === 'failed' ? 'Try again' : 'Pass the check'}
              </button>
            </>
          )}
          {savedSessionHint && check.status !== 'passed' && (
            <p className="mt-2 text-muted-foreground">{savedSessionHint.trim()}</p>
          )}
          {manual && !busy && (
            <details className="mt-3">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Other ways to get past it
              </summary>
              {manual}
            </details>
          )}
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            {sourceName} wants a browser check (Cloudflare) that the server can&apos;t pass on its
            own.{savedSessionHint} Open this source in the Projekt Manga desktop app, which passes
            it for you, or paste a session from your browser below.
          </p>
          {manual}
        </>
      )}
    </div>
  );
}
