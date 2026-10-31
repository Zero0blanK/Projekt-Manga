import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY_BINDINGS,
  READER_ACTIONS,
  keyConflicts,
  keyLabel,
  keyMap,
  keyName,
  parseKeyBindings,
  serializeKeyBindings,
} from '@/lib/reader-keys';
import { ZONE_LAYOUTS, zoneAt, zoneGrid } from '@/lib/click-zones';
import { ZOOM_MAX, ZOOM_MIN, clampZoom } from '@/lib/reader-zoom';

const press = (
  key: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {},
) => keyName({ key, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });

describe('reader key bindings', () => {
  it('binds every action by default and keeps the keys the reader always had', () => {
    for (const { id } of READER_ACTIONS) expect(DEFAULT_KEY_BINDINGS[id].length).toBeGreaterThan(0);
    const map = keyMap(DEFAULT_KEY_BINDINGS);
    expect(map.get('ArrowRight')).toBe('nextPage');
    expect(map.get('Space')).toBe('nextPage');
    expect(map.get('ArrowLeft')).toBe('prevPage');
    expect(map.get('+')).toBe('zoomIn');
    expect(map.get('0')).toBe('zoomReset');
    expect(map.get('f')).toBe('toggleControls');
    expect(map.get('a')).toBe('autoScroll');
    expect(keyConflicts(DEFAULT_KEY_BINDINGS).size).toBe(0);
  });

  it('names keys as typed and leaves browser shortcuts alone', () => {
    expect(press(' ')).toBe('Space');
    expect(press('F')).toBe('F');
    expect(press('?')).toBe('?');
    expect(press('PageDown')).toBe('PageDown');
    expect(press('Shift')).toBeNull();
    expect(press('f', { ctrlKey: true })).toBeNull();
    expect(press('ArrowLeft', { altKey: true })).toBeNull();
    expect(press('k', { metaKey: true })).toBeNull();
  });

  it('labels keys for people', () => {
    expect(keyLabel('ArrowRight')).toBe('→');
    expect(keyLabel('F')).toBe('Shift+F');
    expect(keyLabel('f')).toBe('F');
    expect(keyLabel('Space')).toBe('Space');
  });

  it('stores only changed actions and reads them back over the defaults', () => {
    expect(serializeKeyBindings(DEFAULT_KEY_BINDINGS)).toBe('');
    const changed = { ...DEFAULT_KEY_BINDINGS, nextPage: ['j'], prevChapter: [] };
    const stored = serializeKeyBindings(changed);
    expect(JSON.parse(stored)).toEqual({ nextPage: ['j'], prevChapter: [] });
    expect(parseKeyBindings(stored)).toEqual(changed);
  });

  it('keeps the default for anything malformed', () => {
    for (const raw of [undefined, 42, 'not json', '[]', 'null', 'x'.repeat(5000)])
      expect(parseKeyBindings(raw)).toEqual(DEFAULT_KEY_BINDINGS);
    const parsed = parseKeyBindings(
      JSON.stringify({
        nextPage: 'j', // not a list
        prevPage: ['a', 'b', 'c', 'd', 'e'], // too many
        firstPage: [''], // empty key
        lastPage: ['x'.repeat(25)], // too long
        zoomIn: ['i', 'i'], // duplicate, kept once
        unknownAction: ['q'],
      }),
    );
    expect(parsed.nextPage).toEqual(DEFAULT_KEY_BINDINGS.nextPage);
    expect(parsed.prevPage).toEqual(DEFAULT_KEY_BINDINGS.prevPage);
    expect(parsed.firstPage).toEqual(DEFAULT_KEY_BINDINGS.firstPage);
    expect(parsed.lastPage).toEqual(DEFAULT_KEY_BINDINGS.lastPage);
    expect(parsed.zoomIn).toEqual(['i']);
    expect(parsed).not.toHaveProperty('unknownAction');
  });

  it('gives a shared key to the first action and reports the conflict', () => {
    const bindings = { ...DEFAULT_KEY_BINDINGS, chapterList: ['f'] };
    expect(keyMap(bindings).get('f')).toBe('toggleControls');
    expect(keyConflicts(bindings).get('f')).toEqual(['toggleControls', 'chapterList']);
  });
});

describe('click zones', () => {
  it('thirds splits by column only', () => {
    expect(zoneAt(0.1, 0.1, 'Thirds')).toBe('left');
    expect(zoneAt(0.5, 0.9, 'Thirds')).toBe('center');
    expect(zoneAt(0.9, 0.5, 'Thirds')).toBe('right');
    // Unknown layouts fall back to thirds.
    expect(zoneAt(0.9, 0.5, 'bogus')).toBe('right');
  });

  it('L-shape puts the top row with the left and the bottom row with the right', () => {
    expect(zoneAt(0.9, 0.1, 'L-shape')).toBe('left');
    expect(zoneAt(0.1, 0.5, 'L-shape')).toBe('left');
    expect(zoneAt(0.5, 0.5, 'L-shape')).toBe('center');
    expect(zoneAt(0.9, 0.5, 'L-shape')).toBe('right');
    expect(zoneAt(0.1, 0.9, 'L-shape')).toBe('right');
  });

  it('Kindle has a controls strip on top and no middle column below it', () => {
    expect(zoneAt(0.1, 0.1, 'Kindle')).toBe('center');
    expect(zoneAt(0.2, 0.6, 'Kindle')).toBe('left');
    expect(zoneAt(0.5, 0.6, 'Kindle')).toBe('right');
  });

  it('Edges turns pages only at the sides, and Off has no zones', () => {
    expect(zoneAt(0.05, 0.5, 'Edges')).toBe('left');
    expect(zoneAt(0.3, 0.5, 'Edges')).toBe('center');
    expect(zoneAt(0.95, 0.5, 'Edges')).toBe('right');
    expect(zoneAt(0.5, 0.5, 'Off')).toBeNull();
  });

  it('draws a grid for every layout', () => {
    for (const layout of ZONE_LAYOUTS) {
      const grid = zoneGrid(layout, 3, 3);
      expect(grid).toHaveLength(3);
      expect(grid.every((row) => row.length === 3)).toBe(true);
    }
    expect(
      zoneGrid('Off', 2, 2)
        .flat()
        .every((zone) => zone === null),
    ).toBe(true);
  });
});

describe('reader zoom', () => {
  it('clamps to the limits and rounds away float noise', () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(0.1 + 0.2 + 1)).toBe(1.3);
  });
});
