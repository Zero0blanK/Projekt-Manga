import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserAgentManager } from '../features/UserAgentManager.js';
import { REALISTIC_USER_AGENT_PROFILES } from '../config/anon.config.js';

vi.mock('../features/RemoteUserAgent.js', () => ({
  fetchRemoteUserAgentString: vi.fn(),
}));

import { fetchRemoteUserAgentString } from '../features/RemoteUserAgent.js';

describe('UserAgentManager pool basics', () => {
  it('starts with the full static profile pool', () => {
    const mgr = new UserAgentManager();
    expect(mgr.getProfileCount()).toBe(REALISTIC_USER_AGENT_PROFILES.length);
  });

  it('does not mutate the shared default profile pool when adding profiles', () => {
    const before = REALISTIC_USER_AGENT_PROFILES.length;
    const mgr = new UserAgentManager();
    mgr.addProfiles([
      {
        userAgent: 'custom-ua',
        platform: 'Windows',
        browserType: 'Chrome',
        version: '999',
        mobile: false,
        viewport: { width: 1, height: 1 },
        deviceMemory: 1,
        hardwareConcurrency: 1,
        maxTouchPoints: 0,
      },
    ]);

    expect(mgr.getProfileCount()).toBe(before + 1);
    expect(REALISTIC_USER_AGENT_PROFILES.length).toBe(before);
  });

  it('getDesktopProfile only returns non-mobile profiles', () => {
    const mgr = new UserAgentManager();
    for (let i = 0; i < 10; i++) {
      expect(mgr.getDesktopProfile().mobile).toBe(false);
    }
  });

  it('getMobileProfile only returns mobile profiles', () => {
    const mgr = new UserAgentManager();
    for (let i = 0; i < 10; i++) {
      expect(mgr.getMobileProfile().mobile).toBe(true);
    }
  });

  it('getProfileForBrowser filters by browser type', () => {
    const mgr = new UserAgentManager();
    for (let i = 0; i < 10; i++) {
      expect(mgr.getProfileForBrowser('Firefox').browserType).toBe('Firefox');
    }
  });
});

describe('UserAgentManager rotation', () => {
  it('rotateProfile changes the current profile deterministically (round-robin index)', () => {
    const mgr = new UserAgentManager();
    const first = mgr.getCurrentProfile();
    const rotated = mgr.rotateProfile();
    // With more than one profile in the pool, a single rotation should move off the
    // starting index (round-robin, not random) — allow equality only if pool size is 1.
    if (mgr.getProfileCount() > 1) {
      expect(rotated).not.toBe(first);
    }
  });
});

describe('UserAgentManager remote refresh', () => {
  beforeEach(() => {
    vi.mocked(fetchRemoteUserAgentString).mockReset();
  });

  it('merges a successfully fetched remote profile into the pool', async () => {
    vi.mocked(fetchRemoteUserAgentString).mockResolvedValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36',
    );

    const mgr = new UserAgentManager();
    const ok = await mgr.refreshFromRemote();

    expect(ok).toBe(true);
    expect(mgr.isUsingRemoteProfile()).toBe(true);
    expect(mgr.getAllProfiles().some((p) => p.version === '999.0.0.0')).toBe(true);
  });

  it('replaces same-platform/browser entries instead of accumulating duplicates', async () => {
    const mgr = new UserAgentManager();
    const before = mgr.getProfileCount();
    const windowsChromeCount = mgr
      .getAllProfiles()
      .filter((p) => p.platform === 'Windows' && p.browserType === 'Chrome').length;
    expect(windowsChromeCount).toBeGreaterThan(0);

    vi.mocked(fetchRemoteUserAgentString).mockResolvedValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36',
    );
    await mgr.refreshFromRemote();

    const afterWindowsChromeCount = mgr
      .getAllProfiles()
      .filter((p) => p.platform === 'Windows' && p.browserType === 'Chrome').length;

    expect(afterWindowsChromeCount).toBe(1); // all prior Windows/Chrome entries replaced by the one fresh entry
    expect(mgr.getProfileCount()).toBe(before - windowsChromeCount + 1);
  });

  it('leaves the pool untouched when the remote fetch returns nothing', async () => {
    vi.mocked(fetchRemoteUserAgentString).mockResolvedValue(null);

    const mgr = new UserAgentManager();
    const before = mgr.getProfileCount();
    const ok = await mgr.refreshFromRemote();

    expect(ok).toBe(false);
    expect(mgr.isUsingRemoteProfile()).toBe(false);
    expect(mgr.getProfileCount()).toBe(before);
  });

  it('leaves the pool untouched when the remote fetch rejects', async () => {
    vi.mocked(fetchRemoteUserAgentString).mockRejectedValue(new Error('network down'));

    const mgr = new UserAgentManager();
    const before = mgr.getProfileCount();
    const ok = await mgr.refreshFromRemote();

    expect(ok).toBe(false);
    expect(mgr.getProfileCount()).toBe(before);
  });

  it('leaves the pool untouched when the remote fetch returns unparseable garbage', async () => {
    vi.mocked(fetchRemoteUserAgentString).mockResolvedValue('not a real user agent');

    const mgr = new UserAgentManager();
    const before = mgr.getProfileCount();
    const ok = await mgr.refreshFromRemote();

    expect(ok).toBe(false);
    expect(mgr.getProfileCount()).toBe(before);
  });
});
