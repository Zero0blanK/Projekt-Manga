'use client';

import {
  Panel,
  Field,
  Group,
  Select,
  Toggle,
  NumberSelect,
  Range,
} from '@/components/settings/field-controls';
import { PAGE_LAYOUTS, useSetting } from '@/lib/app-store';
import { useMangaLibrary } from '@/lib/library-store';
import {
  DEFAULT_PAGE_PREFETCH,
  DEFAULT_CHAPTER_PREFETCH,
  PAGE_PREFETCH_OPTIONS,
  CHAPTER_PREFETCH_OPTIONS,
  READER_BACKGROUNDS,
  DEFAULT_READER_BACKGROUND,
  DEFAULT_BRIGHTNESS,
  DEFAULT_STRIP_GAP,
  SCROLL_SPEED_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_STEP,
  DEFAULT_SCROLL_SPEED,
  formatScrollSpeed,
  DEFAULT_AUTO_SCROLL_SPEED,
  AUTO_SCROLL_PIXELS_PER_SECOND,
} from '@/lib/reader-settings';
import { actions } from '@/lib/app-store';
import { TAP_ACTIONS } from '@/lib/reader-preferences';
import { ReaderPresets } from '@/components/reader/reader-personal-tools';

export function ReaderPanel() {
  const { manga } = useMangaLibrary();
  const preloadNextChapter = useSetting('preloadNextChapter', true) as boolean;
  const readingDirection = useSetting('readingDirection', 'Right to left') as string;
  const directionSource = useSetting('readerDirectionSource', '') as string;
  const pageLayout = useSetting('pageLayout', 'Two-page spread') as string;
  // Vertical reading forces the long-strip viewer, so the paged-only options below
  // don't apply — same rule the reader itself uses to pick a viewer.
  const longStrip = readingDirection === 'Vertical (webtoon)' || pageLayout === 'Long strip';
  const sources = [...new Set(manga.map((entry) => entry.source))].sort();
  const leftTap = useSetting('readerTapLeft', 'Direction');
  const centerTap = useSetting('readerTapCenter', 'Controls');
  const rightTap = useSetting('readerTapRight', 'Opposite');

  return (
    <div className="space-y-6">
      <Panel title="Reader" subtitle="How chapters are laid out">
        <Field label="Reading direction">
          <Select
            settingKey="readingDirection"
            options={['Right to left', 'Left to right', 'Vertical (webtoon)']}
            defaultValue="Right to left"
          />
        </Field>
        {sources.length > 0 && (
          <>
            <Field
              label="Per-source direction"
              hint="Override the default for titles from one source"
            >
              <Select
                settingKey="readerDirectionSource"
                options={sources}
                defaultValue={sources[0]}
              />
            </Field>
            {directionSource && (
              <Field label={`Direction for ${directionSource}`}>
                <Select
                  settingKey={`readerDirection:${directionSource}`}
                  options={['Use default', 'Right to left', 'Left to right', 'Vertical (webtoon)']}
                  defaultValue="Use default"
                />
              </Field>
            )}
          </>
        )}
        <Field
          label="Page layout"
          hint={longStrip ? 'Vertical reading always uses the long strip' : undefined}
        >
          <Select
            settingKey="pageLayout"
            options={[...PAGE_LAYOUTS]}
            defaultValue="Two-page spread"
          />
        </Field>
        <Field label="Zoom behavior" disabled={longStrip}>
          <Select
            settingKey="zoomBehavior"
            options={['Fit width', 'Fit height', 'Original', 'Smart']}
            defaultValue="Smart"
          />
        </Field>
        <Field
          label="Offset first page"
          hint="Show page 1 alone, so later spreads pair up the way they were drawn"
          disabled={longStrip || pageLayout !== 'Two-page spread'}
        >
          <Toggle settingKey="offsetFirstPage" />
        </Field>
        <Field label="Page gap" hint="Space between pages in the long strip" disabled={!longStrip}>
          <NumberSelect
            settingKey="stripGap"
            options={[0, 4, 8, 16, 24]}
            defaultValue={DEFAULT_STRIP_GAP}
            format={(n) => (n === 0 ? 'Seamless' : `${n} px`)}
          />
        </Field>
        <Field
          label="Scroll speed"
          hint="How far one scroll of the wheel moves the long strip — 1× is your browser's own step"
          disabled={!longStrip}
        >
          <Range
            settingKey="readerScrollSpeed"
            min={SCROLL_SPEED_MIN}
            max={SCROLL_SPEED_MAX}
            step={SCROLL_SPEED_STEP}
            defaultValue={DEFAULT_SCROLL_SPEED}
            format={formatScrollSpeed}
          />
        </Field>
        <Field
          label="Auto-scroll"
          hint="Start scrolling on its own when a chapter opens — the reader's play/pause control works either way"
          disabled={!longStrip}
        >
          <Toggle settingKey="readerAutoScroll" />
        </Field>
        <Field label="Auto-scroll speed" nested disabled={!longStrip}>
          <Range
            settingKey="readerAutoScrollSpeed"
            min={1}
            max={AUTO_SCROLL_PIXELS_PER_SECOND.length}
            step={1}
            defaultValue={DEFAULT_AUTO_SCROLL_SPEED}
            format={(n) => `${n}×`}
          />
        </Field>
      </Panel>

      <Panel
        title="Tap zones"
        subtitle="Paged reading only; swipes and zoom gestures keep their normal behavior"
      >
        <Field label="Left third">
          <Select settingKey="readerTapLeft" options={[...TAP_ACTIONS]} defaultValue="Direction" />
        </Field>
        <Field label="Center third">
          <Select settingKey="readerTapCenter" options={[...TAP_ACTIONS]} defaultValue="Controls" />
        </Field>
        <Field label="Right third">
          <Select settingKey="readerTapRight" options={[...TAP_ACTIONS]} defaultValue="Opposite" />
        </Field>
        <div
          aria-label="Tap zone preview"
          className="grid grid-cols-3 gap-1 rounded border p-4 text-center text-xs"
        >
          <span>Left: {String(leftTap)}</span>
          <span>Center: {String(centerTap)}</span>
          <span>Right: {String(rightTap)}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Direction advances on the left for right-to-left reading; Opposite advances on the right
          for left-to-right reading.
        </p>
        <button
          type="button"
          onClick={() => {
            actions.setSetting('readerTapLeft', 'Direction');
            actions.setSetting('readerTapCenter', 'Controls');
            actions.setSetting('readerTapRight', 'Opposite');
          }}
          className="rounded border px-3 py-2 text-sm"
        >
          Reset tap zones
        </button>
        <Field
          label="Automatically advance to next chapter"
          hint="Off by default. In page mode a short countdown on the last page lets you stay"
        >
          <Toggle settingKey="readerAutoAdvance" />
        </Field>
      </Panel>
      <Panel title="Reader presets" subtitle="Save settings and apply them explicitly">
        <ReaderPresets />
      </Panel>

      <Panel title="Display" subtitle="What the page sits on">
        <Field label="Reader background">
          <Select
            settingKey="readerBackground"
            options={READER_BACKGROUNDS.map((b) => b.label)}
            defaultValue={DEFAULT_READER_BACKGROUND}
          />
        </Field>
        <Field label="Brightness" hint="Dims the page without touching your screen settings">
          <Range
            settingKey="readerBrightness"
            min={30}
            max={100}
            step={5}
            defaultValue={DEFAULT_BRIGHTNESS}
            format={(n) => `${n}%`}
          />
        </Field>
        <Field label="Show page number" hint="A small counter in the corner while reading">
          <Toggle settingKey="showPageNumber" defaultOn />
        </Field>
        <Field label="Immersive mode" hint="Hide the header and progress bar while reading">
          <Toggle settingKey="immersiveMode" defaultOn />
        </Field>
        <Field
          label="Hide controls when scrolling down"
          hint="Scrolling down clears the header and progress bar away from the page; scrolling up brings them back"
          nested
        >
          <Toggle settingKey="readerHideChromeOnScroll" defaultOn />
        </Field>
        <Field label="Keep screen awake" hint="Holds a screen wake lock while the reader is open">
          <Toggle settingKey="keepScreenAwake" />
        </Field>
      </Panel>

      <Panel title="Preloading" subtitle="Trading bandwidth for instant page turns">
        <Group label="Within a chapter" />
        <Field
          label="Pages to preload ahead"
          hint="Images fetched past the page you're on. Higher is smoother but uses more data."
        >
          <NumberSelect
            settingKey="pagePrefetchAhead"
            options={[...PAGE_PREFETCH_OPTIONS]}
            defaultValue={DEFAULT_PAGE_PREFETCH}
            format={(n) => `${n} page${n === 1 ? '' : 's'}`}
          />
        </Field>

        <Group label="Across chapters" />
        <Field
          label="Preload next chapter"
          hint="Warm the following chapter as you near the end of this one"
        >
          <Toggle settingKey="preloadNextChapter" defaultOn />
        </Field>
        <Field
          label="Chapters to preload"
          hint="How far ahead to reach once preloading kicks in"
          nested
          disabled={!preloadNextChapter}
        >
          <NumberSelect
            settingKey="chapterPrefetchCount"
            options={[...CHAPTER_PREFETCH_OPTIONS]}
            defaultValue={DEFAULT_CHAPTER_PREFETCH}
            format={(n) => `${n} chapter${n === 1 ? '' : 's'}`}
          />
        </Field>
      </Panel>
    </div>
  );
}
