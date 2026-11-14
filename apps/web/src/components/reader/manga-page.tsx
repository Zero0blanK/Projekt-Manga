import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useSetting } from '@/lib/app-store';
import { usePageColorFilter } from '@/lib/reader-settings';
import {
  FULL_VIEW,
  READER_CROP_BORDERS,
  colorFilterStyle,
  halfOf,
  isFullView,
  measureContentBounds,
  type ViewRect,
} from '@/lib/page-image';
import { cn } from '@/lib/utils';
import { measurePanels } from '@/lib/panel-detect';
import { READER_ENHANCE, enhancedPageUrl, shouldEnhance } from '@/lib/enhance';
import {
  READER_AUTO_TRANSLATE,
  READER_TRANSLATE_TARGET,
  autoTranslatePage,
  fitFontSize,
  translateTargetFor,
  usePageTranslation,
} from '@/lib/page-translation';
import { FittedText } from '@/components/reader/fitted-text';
import type { Manga } from '@/lib/manga-data';

export function MangaPage({
  manga,
  pageNumber,
  totalPages,
  imageUrl,
  className,
  /** Which dimension `className` constrains, so the other can size to the real image's
   * aspect ratio instead of being locked into a portrait guess — real pages range from
   * tall single pages to wide double-page spreads. "fixed" means className sets both. */
  fit = 'height',
  seamless = false,
  half,
  rotate = false,
  focus,
  panelsRtl,
  onPanels,
  cropAxis = 'both',
  onNaturalSize,
  onReady,
}: {
  manga: Manga;
  pageNumber: number;
  totalPages: number;
  /** Real page image URL (already routed through the server's image proxy), when known. */
  imageUrl?: string;
  className?: string;
  fit?: 'width' | 'height' | 'fixed';
  /** Webtoon-style: no rounded corners or border, so adjacent pages butt together. */
  seamless?: boolean;
  /** Show only this half of the image: one side of a split double page. */
  half?: 'left' | 'right';
  /** Turn the page a quarter clockwise: a double page shown upright on a tall screen. */
  rotate?: boolean;
  /** Which margins "Crop borders" may remove. The long strip keeps top and bottom, which
   * are the gaps between panels. */
  cropAxis?: 'both' | 'horizontal';
  /** Guided view: show only this panel (fractions of the page) instead of the page. */
  focus?: ViewRect | null;
  /** Guided view: find the page's panels once it loads, in this reading direction. */
  panelsRtl?: boolean;
  onPanels?: (panels: ViewRect[]) => void;
  /** The image's real size once it loads, for spotting double pages. */
  onNaturalSize?: (width: number, height: number) => void;
  onReady?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const colorFilter = usePageColorFilter();
  const cropBorders = useSetting(READER_CROP_BORDERS, false) as boolean;
  const enhance = useSetting(READER_ENHANCE, false) as boolean;
  // The enhanced copy of a low-resolution page, once made (lib/enhance.ts).
  const [enhancedSrc, setEnhancedSrc] = useState<string | null>(null);
  const pageKey = useRef('');
  pageKey.current = `${manga.id}:${pageNumber}:${imageUrl}`;
  // Reading pixels needs a CORS-approved image. Should the server not allow this origin,
  // the image is loaded again the ordinary way and shown uncropped instead of failing.
  const [corsRefused, setCorsRefused] = useState(false);
  // Guided view reads pixels too, to find panels.
  const readPixels = (cropBorders || !!onPanels || enhance) && !corsRefused && fit !== 'fixed';
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [content, setContent] = useState<ViewRect>(FULL_VIEW);
  const translation = usePageTranslation(imageUrl);
  const autoTranslate = useSetting(READER_AUTO_TRANSLATE, false) === true;
  const translateInto = useSetting(READER_TRANSLATE_TARGET, 'English') as string;
  // Settings › Reader › Translate pages automatically: as soon as the page has loaded.
  useEffect(() => {
    if (autoTranslate && natural && imageUrl)
      autoTranslatePage(imageUrl, translateTargetFor(translateInto));
  }, [autoTranslate, natural, imageUrl, translateInto]);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setAttempt(0);
    setCorsRefused(false);
    setNatural(null);
    setContent(FULL_VIEW);
    setEnhancedSrc(null);
  }, [manga.id, pageNumber, imageUrl]);
  useEffect(() => {
    if (!enhance) setEnhancedSrc(null);
  }, [enhance]);

  if (!imageUrl) {
    return (
      <Skeleton className={cn('aspect-2/3 bg-white/10', !seamless && 'rounded-lg', className)} />
    );
  }

  // A turned page isn't cropped or halved: it is shown whole, on its side.
  const turned = rotate && natural && fit !== 'fixed';
  const view =
    natural && fit !== 'fixed' && !turned
      ? (focus ?? (half ? halfOf(content, half) : content))
      : FULL_VIEW;
  const viewed = !isFullView(view) && natural;
  // A cropped or halved page: the wrapper takes the visible part's shape and clips, and
  // the image is scaled and shifted so only that part shows through.
  // Turned: the box takes the turned page's (portrait) shape, and the image, sized to the
  // box's height, is centred and rotated into it.
  const wrapperStyle: CSSProperties | undefined = turned
    ? { aspectRatio: `${natural.height} / ${natural.width}` }
    : viewed
      ? { aspectRatio: `${view.w * natural.width} / ${view.h * natural.height}` }
      : undefined;
  const imgStyle: CSSProperties = {
    filter: colorFilterStyle(colorFilter),
    ...(turned && {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: `${(natural.width / natural.height) * 100}%`,
      height: 'auto',
      maxWidth: 'none',
      maxHeight: 'none',
      transform: 'translate(-50%, -50%) rotate(90deg)',
    }),
    ...(viewed && {
      position: 'absolute',
      width: `${100 / view.w}%`,
      height: `${100 / view.h}%`,
      maxWidth: 'none',
      maxHeight: 'none',
      left: `${(-view.x / view.w) * 100}%`,
      top: `${(-view.y / view.h) * 100}%`,
    }),
  };

  const imgSizeClass =
    fit === 'fixed'
      ? 'h-full w-full'
      : fit === 'width'
        ? 'w-full h-auto max-h-full'
        : 'h-full w-auto max-w-full';

  return (
    <div
      className={cn(
        'relative overflow-hidden',
        // Until the real image loads (and we know its actual aspect ratio), hold a
        // guessed portrait box so layout doesn't collapse to zero size; once loaded,
        // drop it so the box reflows to the image's real shape instead of letterboxing.
        !loaded && 'aspect-2/3',
        // Borders are skipped in seamless mode: adjacent borders would draw a visible line
        // between pages. The bordered, rounded card look is for the spaced modes.
        seamless ? '' : 'rounded-lg border border-white/5',
        className,
      )}
      style={wrapperStyle}
      data-page={pageNumber}
      data-image-url={imageUrl}
      data-enhanced={enhancedSrc ? 'true' : undefined}
      data-translated={translation?.status === 'done' && translation.shown ? 'true' : undefined}
    >
      {!loaded && !failed && (
        <Skeleton className={cn('absolute inset-0 bg-white/10', !seamless && 'rounded-lg')} />
      )}
      {failed && (
        <div
          role="alert"
          className="absolute inset-0 z-10 grid place-content-center gap-3 bg-black/90 p-4 text-center text-sm text-white"
        >
          <p>Page {pageNumber} could not load.</p>
          <button
            type="button"
            className="rounded border border-white/30 px-4 py-2"
            onClick={() => {
              setFailed(false);
              setLoaded(false);
              setAttempt((value) => value + 1);
            }}
          >
            Retry page {pageNumber}
          </button>
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external hosts via the server's image proxy */}
      <img
        key={`${attempt}:${readPixels}`}
        src={enhancedSrc ?? imageUrl}
        crossOrigin={readPixels ? 'use-credentials' : undefined}
        alt={`${manga.title} — page ${pageNumber} of ${totalPages}`}
        onLoad={(event) => {
          const img = event.currentTarget;
          setNatural({ width: img.naturalWidth, height: img.naturalHeight });
          onNaturalSize?.(img.naturalWidth, img.naturalHeight);
          setContent(
            readPixels && cropBorders
              ? measureContentBounds(img, cropAxis === 'horizontal')
              : FULL_VIEW,
          );
          if (onPanels) onPanels(readPixels ? measurePanels(img, panelsRtl ?? true) : []);
          // A page smaller than it's shown gets the enhanced copy once it's ready; the
          // copy's own load lands here too, and is left alone.
          if (
            enhance &&
            readPixels &&
            !enhancedSrc &&
            shouldEnhance(
              img.naturalWidth,
              img.naturalHeight,
              img.parentElement?.getBoundingClientRect().width ?? 0,
              window.devicePixelRatio || 1,
            )
          ) {
            const key = pageKey.current;
            void enhancedPageUrl(img).then((url) => {
              if (url && pageKey.current === key) setEnhancedSrc(url);
            });
          }
          setLoaded(true);
          setFailed(false);
          onReady?.();
        }}
        onError={() => {
          if (readPixels) {
            setCorsRefused(true);
            return;
          }
          setFailed(true);
          setLoaded(false);
        }}
        loading={seamless ? 'lazy' : 'eager'}
        className={cn(viewed || turned ? '' : imgSizeClass, 'object-contain')}
        style={imgStyle}
      />
      {/* Translate page: each translation over the text it replaces, in page fractions
          mapped through the visible part. A turned page shows the original. */}
      {translation?.status === 'done' && translation.shown && natural && !turned && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ containerType: 'inline-size' }}
          aria-label={`Translation of page ${pageNumber}`}
        >
          {translation.regions.map((region, index) => (
            <FittedText
              key={index}
              text={region.text}
              lang={translation.target}
              // Never larger than the estimate, and never above dialogue size (about 3% of
              // the page's width): the fit then shrinks it into the bubble.
              maxSize={Math.min(
                3,
                fitFontSize(
                  region.text,
                  region.w / view.w,
                  region.h / view.h,
                  (view.h * natural.height) / (view.w * natural.width),
                ) * 100,
              )}
              style={{
                left: `${((region.x - view.x) / view.w) * 100}%`,
                top: `${((region.y - view.y) / view.h) * 100}%`,
                width: `${(region.w / view.w) * 100}%`,
                height: `${(region.h / view.h) * 100}%`,
              }}
            />
          ))}
        </div>
      )}
      {translation?.status === 'working' && (
        <div
          role="status"
          className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/80 px-3 py-1 text-xs text-white"
        >
          Translating page {pageNumber}…
        </div>
      )}
    </div>
  );
}
