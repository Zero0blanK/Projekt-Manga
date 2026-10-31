'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldQuestion } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { openSourceBrowser, sourceBrowserBridge, sourceSessionKey } from '@/lib/source-browser';
import { useSources } from '@/lib/library-store';
import { SourceSessionManager } from './source-session-manager';

/**
 * Shown when a source answered with a Cloudflare check. On the desktop app the reader can
 * pass it in a window of the source's own site; the cookies it earns are then sent with
 * the source's requests. Either way the reader can instead paste a session they earned in
 * their own browser.
 */
export function SourceChallengeNotice({
  sourceId,
  sourceName,
  onPassed,
  compact = false,
}: {
  sourceId: string;
  sourceName: string;
  /** Called after the window closed and its session was saved — usually a retry. */
  onPassed?: () => void;
  compact?: boolean;
}) {
  // Read after mount: the bridge only exists in the desktop renderer, and the server
  // render must match the first client render.
  const [desktop, setDesktop] = useState(false);
  const [opening, setOpening] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => setDesktop(sourceBrowserBridge() !== undefined), []);
  const siteUrl = useSources().sources.find((source) => source.id === sourceId)?.base_url;

  const open = async () => {
    setOpening(true);
    try {
      const result = await openSourceBrowser(sourceId);
      toast({ description: result.message });
      if (result.saved) {
        void queryClient.invalidateQueries({ queryKey: sourceSessionKey(sourceId) });
        onPassed?.();
      }
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : `Couldn't open ${sourceName}.`,
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className={compact ? 'mt-2 text-xs' : 'mx-auto mt-3 max-w-md text-xs'}>
      {desktop ? (
        <>
          <p className="text-muted-foreground">
            {sourceName} wants a browser check. Open it, pass the check (or sign in), then close the
            window. This only works while the server runs on this computer, as the desktop
            app&apos;s built-in server does.
          </p>
          <button
            type="button"
            onClick={() => void open()}
            disabled={opening}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 font-medium text-foreground transition hover:bg-accent disabled:opacity-60"
          >
            <ShieldQuestion className="h-3.5 w-3.5" aria-hidden />
            {opening ? 'Waiting for the browser window…' : 'Open in browser'}
          </button>
        </>
      ) : (
        <p className="text-muted-foreground">
          {sourceName} wants a browser check (Cloudflare) that the server can&apos;t pass on its
          own. Open this source in the Projekt Manga desktop app, which runs its own server on your
          computer, to pass the check there, or paste a session from your browser below.
        </p>
      )}
      {siteUrl && (
        <SourceSessionManager
          sourceId={sourceId}
          sourceName={sourceName}
          siteUrl={siteUrl}
          onSaved={onPassed}
        />
      )}
    </div>
  );
}
