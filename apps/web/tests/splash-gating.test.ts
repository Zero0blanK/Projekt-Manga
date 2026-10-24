import { afterEach, describe, expect, it } from 'vitest';
import {
  SPLASH_INIT_SCRIPT,
  SPLASH_LAST_SHOWN_KEY,
  SPLASH_SESSION_KEY,
  SPLASH_SKIP_ATTR,
} from '@/lib/splash';

// Node's own (file-backed) localStorage global shadows jsdom's here, so give the script a
// plain in-memory one, as the static-data cache tests do.
const values = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => Array.from(values.keys())[index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, String(value)),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage });
Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage });

function runInitScript(referrer = '') {
  Object.defineProperty(document, 'referrer', { configurable: true, value: referrer });
  new Function(SPLASH_INIT_SCRIPT)();
  return document.documentElement.hasAttribute(SPLASH_SKIP_ATTR);
}

afterEach(() => {
  document.documentElement.removeAttribute(SPLASH_SKIP_ATTR);
  sessionStorage.clear();
  localStorage.clear();
});

describe('boot splash gating', () => {
  it('plays on a first visit and records it for the browser', () => {
    expect(runInitScript()).toBe(false);
    expect(Number(localStorage.getItem(SPLASH_LAST_SHOWN_KEY))).toBeGreaterThan(0);
  });

  it('skips in a new tab when this browser showed it recently', () => {
    localStorage.setItem(SPLASH_LAST_SHOWN_KEY, String(Date.now() - 60_000));
    expect(runInitScript()).toBe(true);
  });

  it('skips when the page was opened from inside the app', () => {
    expect(runInitScript(`${window.location.origin}/discover`)).toBe(true);
  });

  it('skips on a reload in the same tab', () => {
    sessionStorage.setItem(SPLASH_SESSION_KEY, '1');
    expect(runInitScript()).toBe(true);
  });

  it('plays again after a long gap, from an outside link', () => {
    localStorage.setItem(SPLASH_LAST_SHOWN_KEY, String(Date.now() - 2 * 24 * 60 * 60 * 1000));
    expect(runInitScript('https://elsewhere.example/')).toBe(false);
  });
});
