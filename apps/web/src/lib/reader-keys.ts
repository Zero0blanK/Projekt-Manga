/**
 * Reader input (Settings › Reader › Keyboard): the actions a key, a mouse button or a
 * gamepad button can trigger, their default keys, and the stored overrides.
 *
 * One registry for every input so the shortcut sheet, the settings list and the readers
 * all agree on what a key does. Kept free of React so it can be tested on its own.
 */

export const READER_ACTIONS = [
  { id: 'nextPage', label: 'Next page' },
  { id: 'prevPage', label: 'Previous page' },
  { id: 'firstPage', label: 'First page' },
  { id: 'lastPage', label: 'Last page' },
  { id: 'nextChapter', label: 'Next chapter' },
  { id: 'prevChapter', label: 'Previous chapter' },
  { id: 'zoomIn', label: 'Zoom in' },
  { id: 'zoomOut', label: 'Zoom out' },
  { id: 'zoomReset', label: 'Reset zoom' },
  { id: 'fullscreen', label: 'Fullscreen' },
  { id: 'toggleControls', label: 'Show or hide controls' },
  { id: 'chapterList', label: 'Chapter list' },
  { id: 'bookmarkChapter', label: 'Bookmark chapter' },
  { id: 'autoScroll', label: 'Auto-scroll (long strip)' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
] as const;

export type ReaderAction = (typeof READER_ACTIONS)[number]['id'];
export type KeyBindings = Record<ReaderAction, string[]>;

export const READER_KEY_BINDINGS = 'readerKeyBindings';
/** A stored action may have at most this many keys, and a key name this long. */
const MAX_KEYS_PER_ACTION = 4;
const MAX_KEY_LENGTH = 24;

/**
 * Keys are named the way {@link keyName} names an event: a printable character as typed
 * (so "F" is Shift+F and "?" is Shift+/), anything else by its `KeyboardEvent.key`.
 */
export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  nextPage: ['ArrowRight', 'Space', 'PageDown'],
  prevPage: ['ArrowLeft', 'PageUp'],
  firstPage: ['Home'],
  lastPage: ['End'],
  nextChapter: [']'],
  prevChapter: ['['],
  zoomIn: ['+', '='],
  zoomOut: ['-', '_'],
  zoomReset: ['0'],
  fullscreen: ['F11', 'F'],
  toggleControls: ['f'],
  chapterList: ['c'],
  bookmarkChapter: ['b'],
  autoScroll: ['a'],
  shortcuts: ['?'],
};

/** The name of the key an event pressed, or null for a combination the reader leaves to
 * the browser (anything with Ctrl, Cmd or Alt: zoom, find, tab switching). */
export function keyName(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === ' ') return 'Space';
  if (event.key === 'Unidentified' || event.key === 'Dead') return null;
  // Pressing a modifier on its own names no key.
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return null;
  return event.key;
}

/** How a key name reads in the shortcut sheet and settings: "Shift+F", "→", "Space". */
export function keyLabel(key: string): string {
  const named: Record<string, string> = {
    ArrowRight: '→',
    ArrowLeft: '←',
    ArrowUp: '↑',
    ArrowDown: '↓',
    PageDown: 'Page Down',
    PageUp: 'Page Up',
  };
  if (named[key]) return named[key];
  if (key.length === 1 && /[A-Z]/.test(key)) return `Shift+${key}`;
  if (key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase();
  return key;
}

/**
 * The stored bindings over the defaults. Stored as one JSON string (settings hold
 * primitives); an action that is missing or malformed keeps its default, so a bad value
 * never leaves the reader without a way to turn the page.
 */
export function parseKeyBindings(raw: unknown): KeyBindings {
  const bindings: KeyBindings = { ...DEFAULT_KEY_BINDINGS };
  if (typeof raw !== 'string' || raw.length > 4000) return bindings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bindings;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bindings;
  for (const { id } of READER_ACTIONS) {
    const keys = (parsed as Record<string, unknown>)[id];
    if (
      Array.isArray(keys) &&
      keys.length <= MAX_KEYS_PER_ACTION &&
      keys.every((key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH)
    )
      bindings[id] = [...new Set(keys as string[])];
  }
  return bindings;
}

/** Only the actions that differ from the defaults, so a later change to a default still
 * reaches everyone who never touched that action. */
export function serializeKeyBindings(bindings: KeyBindings): string {
  const changed: Partial<KeyBindings> = {};
  for (const { id } of READER_ACTIONS) {
    const keys = bindings[id];
    const defaults = DEFAULT_KEY_BINDINGS[id];
    if (keys.length !== defaults.length || keys.some((key, i) => key !== defaults[i]))
      changed[id] = keys;
  }
  return Object.keys(changed).length ? JSON.stringify(changed) : '';
}

/** Key → action. When two actions share a key the first in READER_ACTIONS order wins,
 * the same order the settings list shows the conflict in. */
export function keyMap(bindings: KeyBindings): Map<string, ReaderAction> {
  const map = new Map<string, ReaderAction>();
  for (const { id } of READER_ACTIONS)
    for (const key of bindings[id]) if (!map.has(key)) map.set(key, id);
  return map;
}

/** Keys bound to more than one action, with the actions sharing each. */
export function keyConflicts(bindings: KeyBindings): Map<string, ReaderAction[]> {
  const byKey = new Map<string, ReaderAction[]>();
  for (const { id } of READER_ACTIONS)
    for (const key of bindings[id]) byKey.set(key, [...(byKey.get(key) ?? []), id]);
  return new Map([...byKey].filter(([, actions]) => actions.length > 1));
}

/**
 * Gamepad buttons in the browser's standard mapping. The d-pad turns pages, the shoulder
 * buttons change chapter and Start toggles the controls; nothing here leaves the reader,
 * so a stray press can't lose the reader's place.
 */
export const GAMEPAD_BINDINGS: ReadonlyMap<number, ReaderAction> = new Map([
  [15, 'nextPage'], // d-pad right
  [13, 'nextPage'], // d-pad down
  [14, 'prevPage'], // d-pad left
  [12, 'prevPage'], // d-pad up
  [5, 'nextChapter'], // right shoulder
  [4, 'prevChapter'], // left shoulder
  [9, 'toggleControls'], // start
]);

/** Mouse back and forward buttons (`MouseEvent.button` 3 and 4). */
export const MOUSE_BUTTON_BINDINGS: ReadonlyMap<number, ReaderAction> = new Map([
  [3, 'prevPage'],
  [4, 'nextPage'],
]);

/** Settings › Reader › Mouse. What the wheel does in the paged reader; Ctrl+wheel always
 * zooms. The long strip scrolls either way. */
export const READER_WHEEL_ACTION = 'readerWheelAction';
export const WHEEL_ACTIONS = ['Turn page', 'Zoom', 'Off'] as const;
/** Double-click zooms in at the cursor (and back out). Costs single clicks a short wait,
 * to tell them from the first half of a double-click. */
export const READER_DOUBLE_CLICK_ZOOM = 'readerDoubleClickZoom';
export const DOUBLE_CLICK_WINDOW_MS = 250;
