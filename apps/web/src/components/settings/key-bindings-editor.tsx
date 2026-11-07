'use client';

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ActionButton } from '@/components/settings/field-controls';
import { actions, useSetting } from '@/lib/app-store';
import {
  READER_ACTIONS,
  READER_KEY_BINDINGS,
  keyConflicts,
  keyLabel,
  keyName,
  parseKeyBindings,
  serializeKeyBindings,
  type KeyBindings,
  type ReaderAction,
} from '@/lib/reader-keys';

const MAX_KEYS = 4;
const save = (next: KeyBindings) =>
  actions.setSetting(READER_KEY_BINDINGS, serializeKeyBindings(next));
const labelOf = (id: ReaderAction) => READER_ACTIONS.find((action) => action.id === id)!.label;

/**
 * Settings › Reader › Keyboard: each reader action with its keys. "Add key" listens for
 * the next key press (Esc cancels). A key bound twice is flagged rather than silently
 * moved, because the first action in the list is the one that gets it.
 */
export function KeyBindingsEditor() {
  const stored = useSetting(READER_KEY_BINDINGS, '');
  const bindings = parseKeyBindings(stored);
  const conflicts = keyConflicts(bindings);
  const [capturing, setCapturing] = useState<ReaderAction | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      // Captured before anything else sees it: this key press is the value being set.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') return setCapturing(null);
      const name = keyName(event);
      if (!name) return; // a modifier on its own, or a browser shortcut combination
      const current = parseKeyBindings(stored);
      if (!current[capturing].includes(name))
        save({ ...current, [capturing]: [...current[capturing], name].slice(0, MAX_KEYS) });
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, stored]);

  return (
    <div className="space-y-1">
      <ul className="divide-y divide-border/50">
        {READER_ACTIONS.map(({ id, label }) => (
          <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-sm">{label}</span>
            <span className="flex flex-wrap items-center justify-end gap-1">
              {bindings[id].map((key) => {
                const shared = conflicts.get(key)?.filter((other) => other !== id) ?? [];
                return (
                  <span key={key} className="inline-flex flex-col items-end">
                    <span
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs ${
                        shared.length
                          ? 'border-amber-500/60 bg-amber-500/10'
                          : 'border-border bg-muted'
                      }`}
                    >
                      {keyLabel(key)}
                      <button
                        type="button"
                        aria-label={`Remove ${keyLabel(key)} from ${label}`}
                        onClick={() =>
                          save({ ...bindings, [id]: bindings[id].filter((k) => k !== key) })
                        }
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                    {shared.length > 0 && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        Also {shared.map(labelOf).join(', ')}
                      </span>
                    )}
                  </span>
                );
              })}
              {bindings[id].length < MAX_KEYS && (
                <button
                  type="button"
                  onClick={() => setCapturing(capturing === id ? null : id)}
                  aria-pressed={capturing === id}
                  className="inline-flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {capturing === id ? (
                    'Press a key… (Esc cancels)'
                  ) : (
                    <>
                      <Plus className="h-3 w-3" /> Add key
                    </>
                  )}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        When a key is listed twice, the action higher in the list gets it. Keys held with Ctrl, Alt
        or Cmd stay with the browser.
      </p>
      <div>
        <ActionButton onClick={() => actions.setSetting(READER_KEY_BINDINGS, '')}>
          Reset keyboard shortcuts
        </ActionButton>
      </div>
    </div>
  );
}
