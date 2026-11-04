'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCoverBlur } from '@/components/discover/cover-privacy-provider';

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

/**
 * A stored library cover at the size this box shows it; the server keeps these widths. A
 * cover still coming from a source is left whole, since resizing it would mean the server
 * downloading it first, with nothing for the ring to show.
 */
function sizedForBox(src: string, cssWidth: number): string {
  if (!src.includes('/cache/thumbnail/')) return src;
  const needed = cssWidth * (window.devicePixelRatio || 1);
  const width = [200, 400, 800].find((candidate) => candidate >= needed) ?? 800;
  return `${src}${src.includes('?') ? '&' : '?'}w=${width}`;
}

/** How far a download has got, as a fraction. */
type Progress = number;

/**
 * Progress for a download whose size the server didn't send: it still moves with every
 * kilobyte that arrives, approaching but never reaching full until the image is done.
 */
const UNSIZED_HALF_BYTES = 48 * 1024;
const unsizedProgress = (received: number) => 0.9 * (received / (received + UNSIZED_HALF_BYTES));

const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A ring that fills as the cover's bytes arrive. It fades in after a moment, so a cover
 * that comes from cache never flashes one.
 */
function CoverProgress({ progress }: { progress: Progress }) {
  return (
    <div
      role="progressbar"
      aria-label="Loading cover"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      className="absolute inset-0 grid place-items-center animate-in fade-in fill-mode-both delay-150 duration-300"
    >
      <svg
        viewBox="0 0 40 40"
        className="size-1/3 max-h-10 max-w-10 -rotate-90 text-primary"
        aria-hidden
      >
        <circle
          cx="20"
          cy="20"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="4"
          className="stroke-foreground/10"
        />
        <circle
          cx="20"
          cy="20"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.max(progress, 0.02))}
          className="transition-[stroke-dashoffset] duration-200 ease-out"
        />
      </svg>
    </div>
  );
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
 * Downloads the image straight from this app's API (the image proxy, or the server's cover
 * cache) rather than through Next's optimizer: the optimizer fetches the whole image on the
 * server before sending anything, so the browser could report no progress while the real
 * download happened. Reading the API's response as it streams is what fills the ring.
 */
export function Cover({
  src,
  alt = '',
  className,
  rounded = 'rounded-md',
  priority = false,
  sourceId,
  mangaId,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
  rounded?: string;
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
  const box = useRef<HTMLDivElement>(null);
  /** Until the box nears the viewport nothing is fetched, like next/image's lazy loading. */
  const [near, setNear] = useState(priority);
  const [progress, setProgress] = useState<Progress>(0);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

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

  const handleLoad = () => {
    if (!src) return;
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
  };

  const handleError = () => {
    if (!src) return;
    hadError.current = true;
    setLoaded(false);
    if (attempts.current >= retryDelays.length) {
      setFailed(true);
    } else if (!retryTimer.current) {
      retry(retryDelays[attempts.current] + retryStagger(src));
    }
  };
  // The download below reports failures through this, without restarting on every render.
  const latestHandleError = useRef(handleError);
  useEffect(() => {
    latestHandleError.current = handleError;
  });

  const current = src ? (imageSrc.base === src ? (imageSrc.value ?? src) : src) : null;

  useEffect(() => {
    if (near) return;
    const element = box.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  const downloadUrl =
    current && near && !failed ? sizedForBox(current, box.current?.clientWidth || 200) : null;

  /**
   * Downloads the cover itself rather than leaving it to an <img>, which reports nothing
   * until it is done; reading the body as it streams is what lets the ring fill. The bytes
   * then reach the <img> as a blob URL, and the browser's HTTP cache still applies.
   */
  useEffect(() => {
    if (!downloadUrl) return;
    const controller = new AbortController();
    let created: string | null = null;
    setProgress(0);
    setObjectUrl(null);
    void (async () => {
      try {
        const response = await fetch(downloadUrl, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`Cover answered ${response.status}`);
        const total = Number(response.headers.get('content-length')) || 0;
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          setProgress(total ? Math.min(1, received / total) : unsizedProgress(received));
        }
        setProgress(1);
        const type = response.headers.get('content-type') ?? undefined;
        created = URL.createObjectURL(new Blob(chunks as BlobPart[], { type }));
        setObjectUrl(created);
      } catch {
        if (!controller.signal.aborted) latestHandleError.current();
      }
    })();
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [downloadUrl]);

  const showPlaceholder = !src || failed;

  return (
    <div ref={box} className={cn('relative overflow-hidden bg-muted', rounded, className)}>
      {showPlaceholder ? (
        <div className="grid h-full w-full place-items-center text-muted-foreground/40">
          <ImageOff className="h-1/4 max-h-5 w-auto" />
        </div>
      ) : (
        <>
          {!loaded && <CoverProgress progress={progress} />}
          {objectUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- the bytes downloaded above
            <img
              src={objectUrl}
              data-src={current ?? undefined}
              alt={blur ? `Adult cover hidden: ${alt}` : alt}
              decoding="async"
              onLoad={handleLoad}
              onError={handleError}
              className={cn(
                'absolute inset-0 h-full w-full object-cover transition-opacity duration-300',
                blur && 'blur-xl',
                loaded ? 'opacity-100' : 'opacity-0',
              )}
            />
          )}
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
