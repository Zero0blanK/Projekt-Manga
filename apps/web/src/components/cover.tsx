'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { ImageOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCoverBlur } from '@/components/discover/cover-privacy-provider';

/**
 * What a cover in the main grid is actually rendered at.
 *
 * The column count varies with the density setting (manga-grid.tsx), so this is the widest
 * card at each breakpoint rather than an exact figure. Erring large is the safe direction:
 * the optimizer never scales a cover *up* past what the source published, so over-declaring
 * costs nothing on a small original and gains real detail on a big one. The 200px default
 * below is sized for list thumbnails and is too small for grid cards.
 */
export const GRID_COVER_SIZES = '(min-width: 1280px) 280px, (min-width: 768px) 240px, 45vw';

const retryDelays = [1_500, 4_000, 9_000, 20_000];
const recoveryListeners = new Map<string, Set<() => void>>();

function recoveryGroup(src: string): string | null {
  try {
    const proxy = new URL(src, 'http://localhost');
    if (!proxy.pathname.endsWith('/api/source/image-proxy')) return null;
    const target = proxy.searchParams.get('url');
    if (!target) return null;
    return `${proxy.searchParams.get('source_id') ?? ''}:${new URL(target).host}`;
  } catch {
    return null;
  }
}

function retryStagger(src: string): number {
  let hash = 0;
  for (const character of src) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 900;
}

/**
 * Cover art for a manga. Shows the real thumbnail and nothing else — where a source
 * doesn't supply one, it falls back to a neutral placeholder rather than a generated
 * colour, so missing covers are easy to spot.
 *
 * `className` sizes the box (the caller decides aspect/dimensions); the image fills it.
 *
 * Uses next/image rather than a bare <img>: covers are the bulk of what this app
 * downloads, they're rendered small (a 44px-wide list row showing a 900px source file),
 * and every one arrives through this app's API — so narrow remotePatterns entries
 * (see next.config.ts) authorise the lot and the optimizer can
 * serve AVIF/WebP at the size actually displayed. The reader's page images deliberately
 * stay on a plain <img>: those need to reflow to each scan's real aspect ratio, which
 * rules out the fixed dimensions next/image requires.
 */
export function Cover({
  src,
  alt = '',
  className,
  rounded = 'rounded-md',
  /** Matches the rendered width so the optimizer picks a sensible candidate. The default
   * covers the small list/grid thumbnails that make up nearly every use; pass a real
   * value for anything displayed large, like a detail-page hero. */
  sizes = '200px',
  /**
   * Higher than Next's default 75. A cover is a second lossy encode of a JPEG a source
   * already compressed, and at the sizes shown here that shows up as mush around line
   * art and lettering. 85 is a few KiB more for a visible difference; the covers are
   * small files either way.
   */
  quality = 85,
  priority = false,
  sourceId,
  mangaId,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
  rounded?: string;
  sizes?: string;
  quality?: number;
  priority?: boolean;
  sourceId?: string;
  mangaId?: string;
}) {
  const blur = useCoverBlur(sourceId, mangaId);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [imageSrc, setImageSrc] = useState({ base: src, value: src });
  const attempts = useRef(0);
  const hadError = useRef(false);
  const recoveryUsed = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const retry = useCallback(
    (delay: number, resetAttempts = false) => {
      if (!src) return;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (resetAttempts) attempts.current = 0;
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        attempts.current += 1;
        setFailed(false);
        setLoaded(false);
        // A new proxy URL also gives Next's optimizer a new cache key after a 429/502.
        setImageSrc({
          base: src,
          value: `${src}${src.includes('?') ? '&' : '?'}_pm_retry=${Date.now()}-${attempts.current}`,
        });
      }, delay);
    },
    [src],
  );

  useEffect(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    attempts.current = 0;
    hadError.current = false;
    recoveryUsed.current = false;
    setFailed(false);
    setLoaded(false);
    setImageSrc({ base: src, value: src });
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [src]);

  useEffect(() => {
    if (!src) return;
    const group = recoveryGroup(src);
    if (!group) return;
    const listeners = recoveryListeners.get(group) ?? new Set<() => void>();
    const onRecovery = () => {
      if (!hadError.current || recoveryUsed.current) return;
      recoveryUsed.current = true;
      retry(150 + retryStagger(src), true);
    };
    listeners.add(onRecovery);
    recoveryListeners.set(group, listeners);
    return () => {
      listeners.delete(onRecovery);
      if (listeners.size === 0) recoveryListeners.delete(group);
    };
  }, [src, retry]);

  const showPlaceholder = !src || failed;

  return (
    <div className={cn('relative overflow-hidden bg-muted', rounded, className)}>
      {showPlaceholder ? (
        <div className="grid h-full w-full place-items-center text-muted-foreground/40">
          <ImageOff className="h-1/4 max-h-5 w-auto" />
        </div>
      ) : (
        <>
          {/* Neutral tone underneath until the bytes arrive, so the box never flashes. */}
          {!loaded && <div className="absolute inset-0 animate-pulse bg-muted" />}
          <Image
            src={imageSrc.base === src ? (imageSrc.value ?? src) : src}
            alt={blur ? `Adult cover hidden: ${alt}` : alt}
            fill
            sizes={sizes}
            quality={quality}
            priority={priority}
            onLoad={() => {
              if (retryTimer.current) clearTimeout(retryTimer.current);
              retryTimer.current = null;
              const recovered = hadError.current;
              hadError.current = false;
              recoveryUsed.current = false;
              attempts.current = 0;
              setLoaded(true);
              if (recovered) {
                const group = recoveryGroup(src);
                if (group) for (const listener of recoveryListeners.get(group) ?? []) listener();
              }
            }}
            onError={() => {
              hadError.current = true;
              setLoaded(false);
              if (attempts.current >= retryDelays.length) {
                setFailed(true);
              } else if (!retryTimer.current) {
                retry(retryDelays[attempts.current] + retryStagger(src));
              }
            }}
            className={cn(
              'object-cover transition-opacity duration-300',
              blur && 'blur-xl',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
          />
        </>
      )}
      {blur && (
        <span className="absolute inset-0 z-10 grid place-items-center bg-background/40 text-xs font-semibold">
          Adult cover blurred
        </span>
      )}
    </div>
  );
}
