// A deliberately hostile "installed extension" bundle, used only by
// tests/sandbox.test.ts to prove the sandbox actually blocks what it claims to. Every
// method here tries something a real malicious source might, and reports what happened
// rather than throwing, so the test can assert on the *outcome* of each attempt.
import fs from 'node:fs';

/**
 * A source's own error class, defined here rather than imported — which is the point.
 * A real bundle is self-contained, so the class the parent sees is never the same one
 * apps/extensions declares; the classification has to survive on shape alone.
 */
class FixtureSourceError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.sourceId = 'hostile-test-source';
    this.statusCode = options.statusCode;
    this.reason = options.reason;
    this.detail = options.detail;
    this.url = options.url;
  }
}

export default {
  id: 'hostile-test-source',
  name: 'Hostile Test Source',
  lang: 'en',
  base_url: 'https://example.invalid',
  isNSFW: false,

  async fetchManga() {
    const results = {};

    // 1. Try to read a secret the parent never handed this process.
    results.envSecret = process.env.SUPER_SECRET_TEST_VALUE ?? null;

    // 2. Try to read a file outside this bundle's own directory.
    try {
      const content = fs.readFileSync(new URL('../../../../package.json', import.meta.url));
      results.readOutside = content.toString('utf-8').slice(0, 20);
    } catch (error) {
      results.readOutside = null;
      results.readOutsideErrorCode = error.code ?? null;
    }

    // 3. Try to fetch a host that IS on this source's allowlist (the test's own local
    // server) — should succeed via the fetch-proxy shim. The URL is read from a sibling
    // config file (same directory as this bundle, so still inside the fs read
    // allowlist) rather than an env var, since the child's environment is scrubbed.
    try {
      const config = JSON.parse(
        fs.readFileSync(new URL('./test-config.json', import.meta.url), 'utf-8'),
      );
      const res = await fetch(config.allowedTestUrl);
      results.allowedFetchStatus = res.status;
      results.allowedFetchBody = await res.text();
    } catch (error) {
      results.allowedFetchError = error.message;
    }

    // 4. Try to fetch a host that is NOT on the allowlist — should be denied before any
    // real network attempt is made.
    try {
      await fetch('https://not-on-the-allowlist.invalid/');
      results.disallowedFetchSucceeded = true;
    } catch (error) {
      results.disallowedFetchError = error.message;
    }

    // 5. Fetch an allowlisted host that redirects to a host NOT on the allowlist —
    // proves the proxy re-validates every redirect hop instead of blindly following it
    // (fetch()'s default redirect:"follow" would otherwise let an allowlisted host
    // redirect straight to a private/internal address and this would silently succeed).
    try {
      const config = JSON.parse(
        fs.readFileSync(new URL('./test-config.json', import.meta.url), 'utf-8'),
      );
      if (config.redirectToDisallowedUrl) {
        await fetch(config.redirectToDisallowedUrl);
        results.redirectFetchSucceeded = true;
      }
    } catch (error) {
      results.redirectFetchError = error.message;
    }

    return results;
  },

  async searchManga() {
    return [];
  },
  /**
   * Starts a proxied request the parent will still be waiting on when this call's own
   * timeout fires and kills this process. Used to prove the parent survives having to
   * deliver a fetch reply to a child that no longer exists — the reply lands on a closed
   * IPC channel, which is an unhandled 'error' event unless the parent guards the send.
   */
  async fetchMangaThumbnail() {
    const config = JSON.parse(
      fs.readFileSync(new URL('./test-config.json', import.meta.url), 'utf-8'),
    );
    const controller = new AbortController();
    const timer = config.signalAbortMs
      ? setTimeout(() => controller.abort(), config.signalAbortMs)
      : undefined;
    let res;
    try {
      res = await fetch(config.slowUrl, { signal: controller.signal });
    } finally {
      if (timer) clearTimeout(timer);
    }
    return await res.text();
  },
  async fetchMangaDetails() {
    throw new Error('not implemented in hostile fixture');
  },
  async fetchChapters() {
    throw new FixtureSourceError('BLOCKED', 'Hostile Test Source blocked this request.', {
      statusCode: 403,
      reason: 'Cloudflare challenge',
      detail: 'HTTP 403 with a challenge body',
      url: 'https://example.invalid/manga',
    });
  },
  async fetchChapterPages() {
    return { items: [], total: 0 };
  },
  async getFilters() {
    return [];
  },
  // Claims a code the app doesn't define — a source must not be able to invent its own
  // classification, since the code selects an HTTP status on the other side.
  async fetchMangaUpdates() {
    throw new FixtureSourceError('TOTALLY_MADE_UP', 'Made-up classification.', {
      statusCode: 418,
      reason: 'should not be trusted',
    });
  },
};
