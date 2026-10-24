'use client';

import { actions, useSetting } from '@/lib/app-store';
import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  DEFAULT_UI_SCALE,
  THEMES,
  UI_SCALES,
  isValidAccent,
  resolveTheme,
} from '@/lib/theme';
import { Panel, Field, Group, Select, Toggle } from '@/components/settings/field-controls';
import { Check } from 'lucide-react';

/** A miniature of the theme — page background, a raised card, and a line of text — so the
 * choice can be made by eye instead of by guessing what "Dim" means. */
function ThemeCard({
  option,
  selected,
  onSelect,
}: {
  option: (typeof THEMES)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={`group overflow-hidden rounded-xl border text-left transition ${
        selected ? 'border-primary ring-1 ring-primary/40' : 'border-border/60 hover:border-border'
      }`}
    >
      <div
        className="relative flex h-16 items-end gap-1.5 p-2"
        style={{ background: option.preview.background }}
      >
        <div
          className="h-8 w-6 rounded-sm"
          style={{ background: option.preview.surface }}
          aria-hidden
        />
        <div className="flex-1 space-y-1" aria-hidden>
          <div
            className="h-1.5 w-full rounded-full opacity-90"
            style={{ background: option.preview.foreground }}
          />
          <div
            className="h-1.5 w-2/3 rounded-full opacity-40"
            style={{ background: option.preview.foreground }}
          />
        </div>
        {selected && (
          <span className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-2.5 w-2.5" />
          </span>
        )}
      </div>
      <div className="border-t border-border/50 bg-background/60 px-2.5 py-1.5">
        <div className={`text-xs font-medium ${selected ? 'text-primary' : 'text-foreground'}`}>
          {option.label}
        </div>
        <div className="text-[10px] text-muted-foreground">{option.hint}</div>
      </div>
    </button>
  );
}

export function AppearancePanel() {
  // Stored values are lowercase ids; lowercasing also normalizes legacy capitalised values ("Dark").
  const storedTheme = String(useSetting('theme', DEFAULT_THEME)).toLowerCase();
  const accent = useSetting('accent', DEFAULT_ACCENT) as string;
  const customAccent = !ACCENTS.some((a) => a.value.toLowerCase() === accent.toLowerCase());

  return (
    <div className="space-y-6">
      <Panel title="Appearance" subtitle="Theme, accent, and interface scale">
        <div>
          <div className="text-sm font-medium text-foreground">Theme</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {storedTheme === 'auto'
              ? `Following your system — currently ${resolveTheme('auto')}.`
              : 'Applied instantly, and before the page paints on your next visit.'}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {THEMES.map((t) => (
              <ThemeCard
                key={t.id}
                option={t}
                selected={storedTheme === t.id}
                onSelect={() => actions.setSetting('theme', t.id)}
              />
            ))}
          </div>
        </div>

        <Field label="Accent color" hint="Buttons, links, focus rings, and progress bars">
          <div className="flex flex-col items-end gap-2.5">
            <div className="flex flex-wrap justify-end gap-2">
              {ACCENTS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => actions.setSetting('accent', c.value)}
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={accent.toLowerCase() === c.value.toLowerCase()}
                  className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-background transition ${
                    accent.toLowerCase() === c.value.toLowerCase()
                      ? 'ring-2 ring-foreground'
                      : 'hover:scale-110'
                  }`}
                  style={{ background: c.value }}
                />
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
              <span className={customAccent ? 'text-primary' : ''}>Custom</span>
              <input
                type="color"
                value={isValidAccent(accent) ? accent : DEFAULT_ACCENT}
                onChange={(e) => actions.setSetting('accent', e.target.value)}
                aria-label="Custom accent color"
                className={`h-6 w-10 cursor-pointer rounded border bg-transparent ${
                  customAccent ? 'border-primary' : 'border-border/60'
                }`}
              />
              <button
                onClick={() => actions.setSetting('accent', DEFAULT_ACCENT)}
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Reset
              </button>
            </label>
          </div>
        </Field>
      </Panel>

      <Panel title="Layout" subtitle="How much fits on screen">
        <Field
          label="Interface scale"
          hint="Scales every element — text, spacing, and controls together"
        >
          <Select settingKey="uiScale" options={[...UI_SCALES]} defaultValue={DEFAULT_UI_SCALE} />
        </Field>
        <Field label="Interface density" hint="Padding inside cards and settings rows">
          <Select
            settingKey="density"
            options={['Comfortable', 'Compact', 'Cozy']}
            defaultValue="Comfortable"
          />
        </Field>
        <Field label="Library grid size" hint="Cover size in the library and Discover grids">
          <Select
            settingKey="gridSize"
            options={['Small', 'Medium', 'Large']}
            defaultValue="Medium"
          />
        </Field>
        <Field label="Show chapter badge on covers" hint="The latest chapter number chip">
          <Toggle settingKey="showChapterBadge" defaultOn />
        </Field>
      </Panel>

      <Panel title="Motion" subtitle="Animation and transitions">
        <Group label="Accessibility" />
        <Field
          label="Reduce motion"
          hint="Near-instant transitions everywhere. Your OS setting is respected separately."
        >
          <Toggle settingKey="reduceMotion" />
        </Field>
        <Field label="Smooth scrolling" hint="Animate jumps to a page or chapter">
          <Toggle settingKey="smoothScroll" defaultOn />
        </Field>
      </Panel>
    </div>
  );
}
