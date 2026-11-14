import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_STATE_STORAGE_KEY,
  DEFAULT_ACCENT,
  FROST_ACCENTS,
  THEME_INIT_SCRIPT,
  applyAppearance,
  effectiveAccent,
  resolveFrostTheme,
  resolveUiStyle,
  shownAccent,
} from '@/lib/theme';

const root = document.documentElement;

afterEach(() => {
  root.className = '';
  for (const name of ['data-theme', 'data-ui', 'data-frost', 'style']) root.removeAttribute(name);
  localStorage.clear();
});

const runInitScript = (settings: Record<string, unknown>) => {
  root.className = '';
  root.removeAttribute('style');
  localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({ settings }));
  new Function(THEME_INIT_SCRIPT)();
};

const frost = (settings: Partial<Parameters<typeof applyAppearance>[0]> = {}) =>
  applyAppearance({
    theme: 'dark',
    accent: undefined,
    uiScale: '100%',
    reduceMotion: false,
    uiStyle: 'frost',
    ...settings,
  });

describe('interface style', () => {
  it('is Classic unless Frost was chosen', () => {
    expect(resolveUiStyle(undefined)).toBe('classic');
    expect(resolveUiStyle('something else')).toBe('classic');
    expect(resolveUiStyle('frost')).toBe('frost');
  });

  it("uses Frost's own palettes, Original by default", () => {
    expect(resolveFrostTheme(undefined)).toBe('original');
    expect(resolveFrostTheme('warm')).toBe('warm');
    expect(resolveFrostTheme('paper')).toBe('original');
  });

  it("leaves the accent to Frost's palette until one is picked", () => {
    expect(effectiveAccent(undefined, 'classic')).toBe(DEFAULT_ACCENT);
    expect(effectiveAccent('', 'frost')).toBeNull();
    expect(effectiveAccent('#e9a25a', 'frost')).toBe('#e9a25a');
    expect(shownAccent('', 'frost', 'midnight')).toBe(FROST_ACCENTS.midnight);
  });

  it('marks <html> with the style and palette at runtime', () => {
    frost({ frostTheme: 'light' });
    expect(root.dataset.ui).toBe('frost');
    expect(root.dataset.frost).toBe('light');
    expect(root.dataset.theme).toBe('light');
    expect(root.classList.contains('dark')).toBe(false);
    // The palette's own accent comes from the stylesheet, not an inline override.
    expect(root.style.getPropertyValue('--primary')).toBe('');
    // A size denser than Classic.
    expect(parseFloat(root.style.fontSize)).toBeCloseTo((100 * 13) / 14, 1);
  });

  it('turns the glass off on request, and leaves Classic untouched', () => {
    frost({ frostTheme: 'warm', frostGlass: false });
    expect(root.classList.contains('frost-off')).toBe(true);
    expect(root.dataset.theme).toBe('dark');

    applyAppearance({ theme: 'paper', accent: undefined, uiScale: '100%', reduceMotion: false });
    expect(root.dataset.ui).toBe('classic');
    expect(root.hasAttribute('data-frost')).toBe(false);
    expect(root.classList.contains('frost-off')).toBe(false);
    expect(root.style.fontSize).toBe('');
  });

  it('is applied before the first paint, the same way', () => {
    runInitScript({ uiStyle: 'frost', frostTheme: 'midnight', frostGlass: false });
    expect(root.dataset.ui).toBe('frost');
    expect(root.dataset.frost).toBe('midnight');
    expect(root.classList.contains('frost-off')).toBe(true);
    expect(root.style.getPropertyValue('--primary')).toBe('');

    runInitScript({ theme: 'dark', accent: '#c07fff' });
    expect(root.dataset.ui).toBe('classic');
    expect(root.style.getPropertyValue('--primary')).toBe('#c07fff');
  });
});
