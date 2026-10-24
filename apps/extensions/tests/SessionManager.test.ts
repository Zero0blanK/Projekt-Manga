import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager, type Session } from '../features/SessionManager.js';
import type { BrowserFingerprint } from '../config/anon.config.js';

const fingerprint: BrowserFingerprint = {
  userAgent: 'Mozilla/5.0 Test',
  platform: 'Win32',
  viewport: { width: 1920, height: 1080 },
  deviceMemory: 8,
  hardwareConcurrency: 8,
  maxTouchPoints: 0,
  timezone: 'America/New_York',
  language: 'en-US',
  languages: ['en-US', 'en'],
  colorDepth: 24,
  pixelRatio: 1,
  webglVendor: 'Google Inc.',
  webglRenderer: 'ANGLE',
};

/** Isolated temp directory per test — never touches the real
 * apps/extensions/data/sessions/ path this repo's dev server uses. */
let storageDir: string;

beforeEach(() => {
  storageDir = mkdtempSync(path.join(tmpdir(), 'session-manager-test-'));
});

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

describe('SessionManager persistence round-trip', () => {
  it('a session created, saved, and reloaded in a fresh instance survives intact', async () => {
    const writer = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: true,
      sessionStoragePath: storageDir,
    });

    const created = writer.createSession(null, fingerprint);
    writer.updateCookies(created.id, [{ name: 'a', value: '1', domain: 'example.com', path: '/' }]);

    await writer.saveToStorage();
    expect(existsSync(path.join(storageDir, 'sessions.json'))).toBe(true);

    const reader = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: true,
      sessionStoragePath: storageDir,
    });

    await reader.loadFromStorage();

    expect(reader.getSessionCount()).toBe(1);
    const reloaded = reader.getSessionById(created.id) as Session;
    expect(reloaded).not.toBeNull();
    expect(reloaded.fingerprint).toEqual(fingerprint);
    expect(reloaded.cookies).toEqual([{ name: 'a', value: '1', domain: 'example.com', path: '/' }]);
  });

  it('skips sessions older than maxSessionAge when loading', async () => {
    const writer = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: true,
      sessionStoragePath: storageDir,
    });

    const oldSession = writer.createSession(null, fingerprint);
    oldSession.createdAt = Date.now() - 999_999_999_999; // far older than maxSessionAge
    await writer.saveToStorage();

    const reader = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: true,
      sessionStoragePath: storageDir,
    });
    await reader.loadFromStorage();

    expect(reader.getSessionCount()).toBe(0);
  });

  it('loadFromStorage() only reads the file once, even if called again', async () => {
    const writer = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: true,
      sessionStoragePath: storageDir,
    });
    writer.createSession(null, fingerprint);
    await writer.saveToStorage();

    const reader = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: true,
      sessionStoragePath: storageDir,
    });
    await reader.loadFromStorage();
    expect(reader.getSessionCount()).toBe(1);

    // A session created after the first load, then a second load() call — since
    // `loaded` is already true, this must be a no-op and not overwrite in-memory state
    // with (or clear it via) a second disk read.
    reader.createSession('http://proxy.example', fingerprint);
    await reader.loadFromStorage();
    expect(reader.getSessionCount()).toBe(2);
  });

  it('loadFromStorage() no-ops cleanly when no file exists yet', async () => {
    const manager = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: true,
      sessionStoragePath: storageDir,
    });

    await expect(manager.loadFromStorage()).resolves.toBeUndefined();
    expect(manager.getSessionCount()).toBe(0);
  });

  it('saveToStorage() is a no-op when persistSessions is false', async () => {
    const manager = new SessionManager({
      isolatePerProxy: true,
      cookieRotationInterval: 3600000,
      maxSessionAge: 86400000,
      persistSessions: false,
      sessionStoragePath: storageDir,
    });

    manager.createSession(null, fingerprint);
    await manager.saveToStorage();

    expect(existsSync(path.join(storageDir, 'sessions.json'))).toBe(false);
  });
});
