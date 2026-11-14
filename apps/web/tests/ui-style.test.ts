import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_STATE_STORAGE_KEY,
  DEFAULT_ACCENT,
  MINIMAL_ACCENT,
  THEME_INIT_SCRIPT,
  applyAppearance,
  effectiveAccent,
  resolveUiStyle,
} from '@/lib/theme';

const root = document.documentElement;

afterEach(() => {
  root.className = '';
  root.removeAttribute('data-theme');
  root.removeAttribute('data-ui');
  root.removeAttribute('style');
  localStorage.clear();
});

const runInitScript = (settings: Record<string, unknown>) => {
  localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({ settings }));
  new Function(THEME_INIT_SCRIPT)();
};

describe('interface style', () => {
  it('is Classic unless Minimal was chosen', () => {
    expect(resolveUiStyle(undefined)).toBe('classic');
    expect(resolveUiStyle('something else')).toBe('classic');
    expect(resolveUiStyle('minimal')).toBe('minimal');
  });

  it("uses the style's own accent until one is picked", () => {
    expect(effectiveAccent(undefined, 'classic')).toBe(DEFAULT_ACCENT);
    expect(effectiveAccent('', 'minimal')).toBe(MINIMAL_ACCENT);
    expect(effectiveAccent('#e9a25a', 'minimal')).toBe('#e9a25a');
  });

  it('marks <html> with the style at runtime', () => {
    applyAppearance({
      theme: 'light',
      accent: undefined,
      uiScale: '100%',
      reduceMotion: false,
      uiStyle: 'minimal',
    });
    expect(root.dataset.ui).toBe('minimal');
    expect(root.dataset.theme).toBe('light');
    expect(root.style.getPropertyValue('--primary')).toBe(MINIMAL_ACCENT);
  });

  it('is applied before the first paint, the same way', () => {
    runInitScript({ theme: 'dark', uiStyle: 'minimal' });
    expect(root.dataset.ui).toBe('minimal');
    expect(root.style.getPropertyValue('--primary')).toBe(MINIMAL_ACCENT);

    runInitScript({ theme: 'dark', accent: '#c07fff' });
    expect(root.dataset.ui).toBe('classic');
    expect(root.style.getPropertyValue('--primary')).toBe('#c07fff');
  });
});
