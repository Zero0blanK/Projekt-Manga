'use client';

import { useState } from 'react';
import { SelectMenu } from '@/components/ui/select-menu';
import { useProfilePreference } from '@/lib/profile-preferences';
import { actions } from '@/lib/app-store';
import { useReaderSettings } from '@/lib/reader-settings';
import {
  COLOR_FILTERS,
  READER_COLOR_FILTER,
  READER_TINT,
  READER_TINT_STRENGTH,
  READER_TINTS,
  tintOpacity,
} from '@/lib/page-image';
import { useCurrentUser } from '@/lib/session-resource';
import {
  parsePageNotes,
  parseReaderPresets,
  parseReaderOverride,
  type PageNote,
  type ReaderPreset,
} from '@/lib/reader-preferences';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';

const EMPTY_PRESETS: ReaderPreset[] = [];
const EMPTY_NOTES: PageNote[] = [];
// The settings controls' input and button styles (see components/settings/field-controls),
// shared by the presets and the page-note dialog.
const PRESET_INPUT =
  'mt-1 w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary/60';
const PRESET_BUTTON =
  'rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50';

export function ReaderPresets({ source, mangaId }: { source?: string; mangaId?: string }) {
  const { user, loading } = useCurrentUser();
  return (
    <ReaderPresetsContent
      key={JSON.stringify([user?.id ?? 'anonymous', loading, source, mangaId])}
      source={source}
      mangaId={mangaId}
    />
  );
}

function ReaderPresetsContent({ source, mangaId }: { source?: string; mangaId?: string }) {
  const settings = useReaderSettings(source, mangaId);
  const [presets, setPresets] = useProfilePreference(
    'reader-presets',
    parseReaderPresets,
    EMPTY_PRESETS,
  );
  const [override, setOverride] = useProfilePreference<ReaderPreset | null>(
    `reader-override:${source ?? ''}:${mangaId ?? ''}`,
    parseReaderOverride,
    null,
  );
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const preset = presets.find((item) => item.name === selected);
  const save = () => {
    const trimmed = name.trim();
    if (
      !trimmed ||
      trimmed.length > 60 ||
      (presets.length >= 30 && !presets.some((item) => item.name === trimmed))
    )
      return;
    const value: ReaderPreset = {
      name: trimmed,
      pageLayout: settings.pageLayout,
      readingDirection: settings.readingDirection,
      zoomBehavior: settings.zoomBehavior,
      brightness: settings.brightness,
      stripGap: settings.stripGap,
      pagePrefetchAhead: settings.pagePrefetchAhead,
      chapterPrefetchCount: settings.chapterPrefetchCount,
      // Normalised, because one out-of-range field makes parseReaderPresets drop the whole
      // list: a hand-edited or stale stored setting must not cost every saved preset.
      colorFilter: (COLOR_FILTERS as readonly string[]).includes(settings.colorFilter)
        ? settings.colorFilter
        : 'None',
      tint: READER_TINTS.some((tint) => tint.label === settings.tint) ? settings.tint : 'None',
      tintStrength: Math.round(tintOpacity(settings.tintStrength) * 100),
    };
    setPresets([...presets.filter((item) => item.name !== trimmed), value]);
    setSelected(trimmed);
    setName('');
  };
  const applyGlobal = () => {
    if (!preset) return;
    const keys: Record<string, string | number> = {
      pageLayout: preset.pageLayout,
      readingDirection: preset.readingDirection,
      zoomBehavior: preset.zoomBehavior,
      readerBrightness: preset.brightness,
      stripGap: preset.stripGap,
      pagePrefetchAhead: preset.pagePrefetchAhead,
      chapterPrefetchCount: preset.chapterPrefetchCount,
      ...(preset.colorFilter !== undefined && { [READER_COLOR_FILTER]: preset.colorFilter }),
      ...(preset.tint !== undefined && { [READER_TINT]: preset.tint }),
      ...(preset.tintStrength !== undefined && { [READER_TINT_STRENGTH]: preset.tintStrength }),
    };
    for (const [key, value] of Object.entries(keys)) actions.setSetting(key, value);
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Presets stay on this device and are included in settings backups.
      </p>
      <label className="block text-xs text-muted-foreground">
        Preset name
        <input
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={PRESET_INPUT}
        />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={
          !name.trim() ||
          (presets.length >= 30 && !presets.some((item) => item.name === name.trim()))
        }
        className={PRESET_BUTTON}
      >
        Save current settings
      </button>
      <div className="space-y-1 text-xs text-muted-foreground">
        Saved preset
        <SelectMenu
          label="Saved preset"
          value={selected}
          onChange={setSelected}
          options={[
            { value: '', label: 'Choose a preset' },
            ...presets.map((item) => ({ value: item.name, label: item.name })),
          ]}
          className="w-full"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!preset} onClick={applyGlobal} className={PRESET_BUTTON}>
          Apply globally
        </button>
        {mangaId && (
          <button
            type="button"
            disabled={!preset}
            onClick={() => preset && setOverride(preset)}
            className={PRESET_BUTTON}
          >
            Apply to this title
          </button>
        )}
        <button
          type="button"
          disabled={!preset}
          onClick={() => {
            setPresets(presets.filter((item) => item.name !== selected));
            setSelected('');
          }}
          className={PRESET_BUTTON}
        >
          Delete preset
        </button>
        {mangaId && override && (
          <button type="button" onClick={() => setOverride(null)} className={PRESET_BUTTON}>
            Use global settings for this title
          </button>
        )}
      </div>
      {override && mangaId && <p role="status">This title uses {override.name}.</p>}
    </div>
  );
}

export function ReaderPersonalTools({
  source,
  mangaId,
  chapterId,
  page,
}: {
  source: string;
  mangaId: string;
  chapterId?: string;
  page: number;
}) {
  const { user, loading } = useCurrentUser();
  return (
    <ReaderPersonalToolsContent
      key={JSON.stringify([user?.id ?? 'anonymous', loading, source, mangaId, chapterId, page])}
      source={source}
      mangaId={mangaId}
      chapterId={chapterId}
      page={page}
    />
  );
}

function ReaderPersonalToolsContent({
  source,
  mangaId,
  chapterId,
  page,
}: {
  source: string;
  mangaId: string;
  chapterId?: string;
  page: number;
}) {
  const [notes, setNotes] = useProfilePreference('page-notes', parsePageNotes, EMPTY_NOTES);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const matches = (note: PageNote) =>
    note.source === source &&
    note.mangaId === mangaId &&
    note.chapterId === chapterId &&
    note.page === page;
  const existing = notes.find(matches);
  const exportNotes = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            notes.filter((note) => note.source === source && note.mangaId === mangaId),
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'page-notes.json';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setDraft(existing?.text ?? '');
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded-lg border border-white/20 px-2 py-1 text-xs text-white"
        >
          Notes & presets
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-auto">
        <DialogTitle>Reader tools</DialogTitle>
        <DialogDescription>
          Notes and title presets are stored on this device. Notes do not change reading progress.
        </DialogDescription>
        <ReaderPresets source={source} mangaId={mangaId} />
        <label className="block text-xs text-muted-foreground">
          Note for page {page}
          <textarea
            disabled={!chapterId}
            maxLength={10000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className={`${PRESET_INPUT} min-h-24`}
          />
        </label>
        {existing && <p className="whitespace-pre-wrap break-words text-sm">{existing.text}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!chapterId || !draft.trim() || (!existing && notes.length >= 5000)}
            onClick={() => {
              if (!chapterId) return;
              setNotes([
                ...notes.filter((note) => !matches(note)),
                { source, mangaId, chapterId, page, text: draft.trim() },
              ]);
            }}
            className={PRESET_BUTTON}
          >
            Save note
          </button>
          <button
            type="button"
            disabled={!existing}
            onClick={() => {
              setNotes(notes.filter((note) => !matches(note)));
              setDraft('');
            }}
            className={PRESET_BUTTON}
          >
            Delete note
          </button>
          <button type="button" onClick={exportNotes} className={PRESET_BUTTON}>
            Export this title&apos;s notes
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
