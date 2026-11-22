'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isProxyPlaceholder, sourceIconUrl } from '@/lib/source-url';
import {
  ENGINE_AUTHOR,
  engineErrorText,
  type useSuwayomiExtensions,
} from '@/lib/engine-extensions';

/**
 * The pieces Discover › Extensions draws the extension engine's rows with. Its data and
 * actions are in lib/engine-extensions.ts.
 */

export function ExtensionIcon({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = sourceIconUrl(url);
  if (!src || failed) return <span aria-hidden className="size-5 shrink-0 rounded bg-secondary" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the server's own image proxy
    <img
      src={src}
      alt=""
      aria-hidden
      width={20}
      height={20}
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={(event) => setFailed(isProxyPlaceholder(event.currentTarget))}
      className="mt-0.5 size-5 shrink-0 rounded object-contain"
    />
  );
}

/** Rows added at a time: the engine can list well over a thousand extensions. */
const ROW_STEP = 60;

/** Renders the first rows of a long list and adds more as the end nears the screen. */
export function GrowingList<T>({
  rows,
  render,
  className,
}: {
  rows: T[];
  render: (row: T) => ReactNode;
  className?: string;
}) {
  const [shown, setShown] = useState(ROW_STEP);
  const end = useRef<HTMLLIElement>(null);
  const more = shown < rows.length;
  useEffect(() => {
    const element = end.current;
    if (!more || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(rows.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown((current) => current + ROW_STEP);
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, rows.length, shown]);
  return (
    <ul className={className}>
      {rows.slice(0, shown).map(render)}
      {more && (
        <li ref={end} className="px-5 py-3 text-xs text-muted-foreground">
          {rows.length - shown} more…
        </li>
      )}
    </ul>
  );
}

/**
 * What the list says about the engine when it has nothing to list: still loading, not
 * reachable (with the way to start the built-in one), or no repository added yet.
 */
export function EngineStatusNotice({
  builtIn,
  list,
}: {
  builtIn: boolean;
  list: ReturnType<typeof useSuwayomiExtensions>['list'];
}) {
  if (list.isPending) {
    return (
      <p className="text-sm text-muted-foreground">Loading {ENGINE_AUTHOR}&apos;s extensions…</p>
    );
  }
  if (list.isError) {
    return (
      <div role="alert" className="space-y-1 text-sm">
        <p className="text-destructive">
          {engineErrorText(
            list.error,
            builtIn
              ? "Couldn't reach the extension engine."
              : "Couldn't reach the Suwayomi server.",
          )}
        </p>
        {builtIn && (
          <a href="/settings#extensions" className="text-xs text-primary hover:underline">
            Download or start it in Settings › Extensions › Extension engine
          </a>
        )}
      </div>
    );
  }
  if (!list.data?.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {builtIn
          ? `No ${ENGINE_AUTHOR} extensions yet. Add an extension repository in Settings › Extensions › Extension engine, then refresh.`
          : `No ${ENGINE_AUTHOR} extensions yet. Add an extension repository on your Suwayomi server, then refresh.`}
      </p>
    );
  }
  return null;
}
