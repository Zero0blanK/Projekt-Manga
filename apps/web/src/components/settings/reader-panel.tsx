'use client';

import {
  Panel,
  Field,
  Group,
  Select,
  Toggle,
  NumberSelect,
  Range,
  ActionButton,
} from '@/components/settings/field-controls';
import { PAGE_LAYOUTS, useSetting } from '@/lib/app-store';
import { READER_TRANSLATE_TARGET, TRANSLATE_LANGUAGES } from '@/lib/page-translation';
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
import { MARK_DUPLICATES_READ, SHOW_CHAPTER_GAPS } from '@/lib/chapter-gaps';
import {
  COLOR_FILTERS,
  READER_COLOR_FILTER,
  READER_CROP_BORDERS,
  READER_TINT,
  READER_TINT_STRENGTH,
  READER_TINTS,
  READER_TINT_CUSTOM,
  READER_TINT_BLEND,
  DEFAULT_TINT_CUSTOM,
  TINT_BLENDS,
  READER_ROTATE_WIDE,
  READER_SWAP_SPREAD,
  DEFAULT_TINT_STRENGTH,
  TINT_STRENGTH_MAX,
  TINT_STRENGTH_MIN,
  READER_SPLIT_WIDE,
} from '@/lib/page-image';
import { ReaderPresets } from '@/components/reader/reader-personal-tools';
import { SKIP_DUPLICATE_CHAPTERS, SKIP_READ_CHAPTERS } from '@/lib/chapter-skip';
import { SKIP_FILTERED_CHAPTERS } from '@/lib/chapter-filter';
import { READER_GUIDED_VIEW } from '@/lib/panel-detect';
import { READER_ENHANCE } from '@/lib/enhance';
import { ZoneLayoutPreview, describeZoneAction } from '@/components/reader/zone-layout-preview';
import { KeyBindingsEditor } from '@/components/settings/key-bindings-editor';
import {
  READER_ZONE_LAYOUT,
  ZONE_LAYOUTS,
  ZONE_LAYOUT_HINTS,
  type ZoneLayout,
} from '@/lib/click-zones';
import { READER_DOUBLE_CLICK_ZOOM, READER_WHEEL_ACTION, WHEEL_ACTIONS } from '@/lib/reader-keys';

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
  const zoneLayout = useSetting(READER_ZONE_LAYOUT, 'Thirds') as string;
  const rtl = readingDirection === 'Right to left';
  const tint = useSetting(READER_TINT, 'None') as string;
  const customTint = useSetting(READER_TINT_CUSTOM, DEFAULT_TINT_CUSTOM) as string;
  const splitWide = useSetting(READER_SPLIT_WIDE, false) as boolean;

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
          hint="Show page 1 alone so spreads pair correctly"
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
          hint="Distance per mouse-wheel step in the long strip"
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
          hint="Start scrolling when a chapter opens"
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
        title="Click zones"
        subtitle="Paged reading only; swipes and zoom gestures keep their normal behavior"
      >
        <Field
          label="Layout"
          hint={ZONE_LAYOUT_HINTS[zoneLayout as ZoneLayout] ?? ZONE_LAYOUT_HINTS.Thirds}
        >
          <Select
            settingKey={READER_ZONE_LAYOUT}
            options={[...ZONE_LAYOUTS]}
            defaultValue="Thirds"
          />
        </Field>
        <Field label="Left zone" disabled={zoneLayout === 'Off'}>
          <Select settingKey="readerTapLeft" options={[...TAP_ACTIONS]} defaultValue="Direction" />
        </Field>
        <Field label="Center zone" disabled={zoneLayout === 'Off'}>
          <Select settingKey="readerTapCenter" options={[...TAP_ACTIONS]} defaultValue="Controls" />
        </Field>
        <Field label="Right zone" disabled={zoneLayout === 'Off'}>
          <Select settingKey="readerTapRight" options={[...TAP_ACTIONS]} defaultValue="Opposite" />
        </Field>
        {zoneLayout !== 'Off' && (
          <div
            aria-label="Click zone preview"
            className="rounded-xl border border-border/60 bg-background/40 p-4 text-muted-foreground"
          >
            <ZoneLayoutPreview
              layout={zoneLayout}
              className="mx-auto w-40"
              labels={{
                left: `Left zone: ${describeZoneAction(String(leftTap), rtl)}`,
                center: `Center zone: ${describeZoneAction(String(centerTap), rtl)}`,
                right: `Right zone: ${describeZoneAction(String(rightTap), rtl)}`,
              }}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Direction advances on the left for right-to-left reading; Opposite advances on the right
          for left-to-right reading.
        </p>
        <div>
          <ActionButton
            onClick={() => {
              actions.setSetting(READER_ZONE_LAYOUT, 'Thirds');
              actions.setSetting('readerTapLeft', 'Direction');
              actions.setSetting('readerTapCenter', 'Controls');
              actions.setSetting('readerTapRight', 'Opposite');
            }}
          >
            Reset click zones
          </ActionButton>
        </div>
      </Panel>

      <Panel title="Mouse and keyboard" subtitle="Desktop reading controls">
        <Field label="Mouse wheel" hint="In the paged reader; Ctrl+wheel always zooms">
          <Select
            settingKey={READER_WHEEL_ACTION}
            options={[...WHEEL_ACTIONS]}
            defaultValue="Turn page"
          />
        </Field>
        <Field
          label="Double-click to zoom"
          hint="Zoom in where you click; single clicks wait a moment to tell them apart"
        >
          <Toggle settingKey={READER_DOUBLE_CLICK_ZOOM} defaultOn />
        </Field>
        <Group label="Keyboard" />
        <KeyBindingsEditor />
      </Panel>

      <Panel title="Chapters" subtitle="Listing chapters and moving between them">
        <Field label="Show missing chapters" hint="Flag gaps in chapter numbers in the list">
          <Toggle settingKey={SHOW_CHAPTER_GAPS} defaultOn />
        </Field>
        <Field
          label="Mark duplicates read"
          hint="Reading a chapter marks its other groups' releases read too"
        >
          <Toggle settingKey={MARK_DUPLICATES_READ} />
        </Field>
        <Field
          label="Skip read chapters"
          hint="Next and previous chapter pass over ones you have already read"
        >
          <Toggle settingKey={SKIP_READ_CHAPTERS} />
        </Field>
        <Field
          label="Skip filtered chapters"
          hint="Next and previous chapter pass over ones the title's chapter-list filter hides"
        >
          <Toggle settingKey={SKIP_FILTERED_CHAPTERS} />
        </Field>
        <Field
          label="Skip duplicate chapters"
          hint="Off: each scanlation group's release is read in turn. On: one release per chapter. A group's own repeats always count once"
        >
          <Toggle settingKey={SKIP_DUPLICATE_CHAPTERS} />
        </Field>
        <Field
          label="Automatically advance to next chapter"
          hint="Continue into the next chapter when you reach the end of one"
        >
          <Toggle settingKey="readerAutoAdvance" defaultOn />
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
        <Field label="Colour filter" hint="Recolour pages for comfort or night reading">
          <Select
            settingKey={READER_COLOR_FILTER}
            options={[...COLOR_FILTERS]}
            defaultValue="None"
          />
        </Field>
        <Field label="Tint" hint="Lay a colour over pages, like a night-light">
          <Select
            settingKey={READER_TINT}
            options={READER_TINTS.map((t) => t.label)}
            defaultValue="None"
          />
        </Field>
        <Field label="Tint strength" nested disabled={tint === 'None'}>
          <Range
            settingKey={READER_TINT_STRENGTH}
            min={TINT_STRENGTH_MIN}
            max={TINT_STRENGTH_MAX}
            step={5}
            defaultValue={DEFAULT_TINT_STRENGTH}
            format={(n) => `${n}%`}
          />
        </Field>
        {tint === 'Custom' && (
          <Field label="Custom tint colour" nested>
            <input
              type="color"
              aria-label="Custom tint colour"
              value={/^#[0-9a-f]{6}$/i.test(customTint) ? customTint : DEFAULT_TINT_CUSTOM}
              onChange={(event) => actions.setSetting(READER_TINT_CUSTOM, event.target.value)}
              className="h-8 w-14 cursor-pointer rounded border border-border/60 bg-transparent"
            />
          </Field>
        )}
        <Field
          label="Tint blend"
          hint="Multiply tints the paper, Screen lightens, Overlay deepens contrast"
          nested
          disabled={tint === 'None'}
        >
          <Select
            settingKey={READER_TINT_BLEND}
            options={[...TINT_BLENDS]}
            defaultValue="Multiply"
          />
        </Field>
        <Field
          label="Enhance low-resolution pages"
          hint="Upscale and sharpen pages smaller than the screen, on your graphics card"
        >
          <Toggle settingKey={READER_ENHANCE} />
        </Field>
        <Field
          label="Translate pages into"
          hint="Right-click a Japanese page and choose Translate page. Text is read on this device; only the text goes to the server's translation service"
        >
          <Select
            settingKey={READER_TRANSLATE_TARGET}
            options={TRANSLATE_LANGUAGES.map(([name]) => name)}
            defaultValue="English"
          />
        </Field>
        <Field label="Crop borders" hint="Trim white or black margins around each page">
          <Toggle settingKey={READER_CROP_BORDERS} />
        </Field>
        <Field
          label="Split wide pages"
          hint="Show double-page spreads as two pages in single-page mode"
          disabled={longStrip || pageLayout !== 'Single page'}
        >
          <Toggle settingKey={READER_SPLIT_WIDE} />
        </Field>
        <Field
          label="Guided view"
          hint="Read panel by panel: next and previous move between a page's panels first"
          disabled={longStrip || pageLayout !== 'Single page'}
        >
          <Toggle settingKey={READER_GUIDED_VIEW} />
        </Field>
        <Field
          label="Rotate wide pages"
          hint="Turn double-page spreads on their side in single-page mode, to use the screen's height"
          disabled={longStrip || pageLayout !== 'Single page' || splitWide}
        >
          <Toggle settingKey={READER_ROTATE_WIDE} />
        </Field>
        <Field
          label="Swap spread order"
          hint="For releases whose two-page spreads come out the wrong way round"
          disabled={longStrip || pageLayout !== 'Two-page spread'}
        >
          <Toggle settingKey={READER_SWAP_SPREAD} />
        </Field>
        <Field label="Show page number" hint="A small counter in the corner while reading">
          <Toggle settingKey="showPageNumber" defaultOn />
        </Field>
        <Field label="Immersive mode" hint="Hide the header and progress bar while reading">
          <Toggle settingKey="immersiveMode" defaultOn />
        </Field>
        <Field
          label="Hide controls when scrolling down"
          hint="Hide them when scrolling down, show them when scrolling up"
          nested
        >
          <Toggle settingKey="readerHideChromeOnScroll" defaultOn />
        </Field>
        <Field label="Keep screen awake" hint="Keep the screen on while reading">
          <Toggle settingKey="keepScreenAwake" />
        </Field>
      </Panel>

      <Panel title="Preloading" subtitle="Trading bandwidth for instant page turns">
        <Group label="Within a chapter" />
        <Field label="Pages to preload ahead" hint="Pages loaded ahead of the one you're on">
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
          hint="How far ahead to preload"
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
