'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { rememberSourceIcon, useCachedSourceIcon } from '@/lib/source-icon-cache';

/**
 * A source's icon that doesn't blink out between visits.
 *
 * Shows the copy kept in this browser (lib/source-icon-cache.ts) at once, and loads the
 * icon's current address only when it differs from the kept one, swapping it in once it has
 * loaded. A kept icon stays when the new address fails, so a refused or rate-limited image
 * no longer replaces it with the lettered tile. `fallback` shows when there is neither.
 */
export function CachedSourceIcon({
  cacheKey,
  url,
  className,
  size,
  fallback,
  frame = (icon) => icon,
}: {
  /** The source's key; the same source shares one icon everywhere it appears. */
  cacheKey: string;
  url: string | null | undefined;
  className?: string;
  size: number;
  fallback: ReactNode;
  /** Wraps the icon when there is one (a tile behind it); the fallback brings its own. */
  frame?: (icon: ReactNode) => ReactNode;
}) {
  const cached = useCachedSourceIcon(cacheKey);
  /** The address that loaded but can't be kept (too large): shown straight from it. */
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!url || cached?.url === url || failedUrl === url || liveUrl === url) return;
    let active = true;
    // Fetched rather than probed with an Image: an SVG without a size of its own reports
    // 0×0 when loaded, which can't be told from the image proxy's empty placeholder.
    void rememberSourceIcon(cacheKey, url).then((outcome) => {
      if (!active) return;
      if (outcome === 'too-large') setLiveUrl(url);
      else if (outcome === 'unusable') setFailedUrl(url);
    });
    return () => {
      active = false;
    };
  }, [cacheKey, url, cached?.url, failedUrl, liveUrl]);

  // The kept copy when there is one; on a first visit, the address itself, so the icon
  // shows as soon as the browser has it while the copy is being kept.
  const live = url && failedUrl !== url ? url : null;
  const src = liveUrl && liveUrl === url ? liveUrl : (cached?.data ?? live);
  if (!src) return <>{fallback}</>;
  return (
    <>
      {frame(
        // eslint-disable-next-line @next/next/no-img-element -- small icons, often SVG data URLs, not optimisable images
        <img
          src={src}
          alt=""
          aria-hidden
          width={size}
          height={size}
          decoding="async"
          className={className}
          onError={() => {
            if (src === url) setFailedUrl(url);
          }}
        />,
      )}
    </>
  );
}
