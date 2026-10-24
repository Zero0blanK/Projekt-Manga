import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLIENT_URL,
  assertValidEnv,
  resetEnvCacheForTests,
} from '../../src/configs/env.js';

/**
 * A hosted deployment that forgets CLIENT_URL has no symptom to debug from: CORS accepts
 * one origin and the session cookie is SameSite=Lax, so the browser silently drops the
 * cookie and login appears to succeed and then does nothing. Startup saying so is the
 * only cheap place to catch it — and it has to stay a warning, because the desktop
 * installer runs in production with CLIENT_URL unset on purpose.
 */
describe('production configuration warnings', () => {
  const original = { ...process.env };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetEnvCacheForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.CLIENT_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    warn.mockRestore();
    process.env = { ...original };
    resetEnvCacheForTests();
  });

  const warnings = () => warn.mock.calls.map((call) => String(call[0])).join('\n');

  it('warns but still starts when NODE_ENV is production and CLIENT_URL is unset', () => {
    process.env.NODE_ENV = 'production';

    expect(() => assertValidEnv()).not.toThrow();
    expect(warnings()).toContain('CLIENT_URL is unset');
    expect(warnings()).toContain(DEFAULT_CLIENT_URL);
  });

  it('stays quiet when CLIENT_URL is set explicitly', () => {
    process.env.NODE_ENV = 'production';
    process.env.CLIENT_URL = 'https://manga.example.com';

    assertValidEnv();

    expect(warnings()).not.toContain('CLIENT_URL');
  });

  it('stays quiet in development, where the default is the right answer', () => {
    process.env.NODE_ENV = 'development';

    assertValidEnv();

    expect(warnings()).not.toContain('CLIENT_URL');
  });

  it('does not warn when production is told to use the default origin on purpose', () => {
    // Explicit and equal to the default is a decision, not an omission — the warning is
    // about the variable being absent, not about its value.
    process.env.NODE_ENV = 'production';
    process.env.CLIENT_URL = DEFAULT_CLIENT_URL;

    assertValidEnv();

    expect(warnings()).not.toContain('CLIENT_URL');
  });
});
