import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Imported from the compiled output, not source: spawnSandboxedSource resolves the
// child entry point (runner.js) relative to its own `import.meta.url`, which only lines
// up with dist/sandbox/runner.js when loaded from dist. This matches how apps/server
// consumes the built package.
import { spawnSandboxedSource } from '../dist/sandbox/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sandbox', 'hostile-source.mjs');

/**
 * Proves the sandbox subsystem (apps/extensions/sandbox/*) actually holds against a
 * deliberately hostile "installed extension" — not just that the happy path works.
 * Requires apps/extensions to be built first (child_process.fork needs the compiled
 * dist/sandbox/runner.js; see the "pretest" hook in package.json).
 */
describe('spawnSandboxedSource (hostile fixture)', () => {
  let server: http.Server | null = null;
  let tmpDir: string | null = null;
  let sandboxed: ReturnType<typeof spawnSandboxedSource> | null = null;

  afterEach(async () => {
    sandboxed?.dispose();
    sandboxed = null;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('blocks env access, filesystem access outside its own directory, and network access outside its allowlist — while still allowing an allowlisted request through', async () => {
    // A tiny local server standing in for "a host this source is actually allowed to
    // reach" — the real allowlist mechanism is exercised regardless of what's on the
    // other end. Also serves a redirect to a host NOT on the allowlist, to prove the
    // proxy re-validates redirect hops rather than blindly following them.
    server = http.createServer((req, res) => {
      if (req.url === '/redirect-to-disallowed') {
        res.writeHead(302, { Location: 'https://not-on-the-allowlist.invalid/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello from the allowed host');
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
    const allowedTestUrl = `http://127.0.0.1:${port}/`;
    const redirectToDisallowedUrl = `http://127.0.0.1:${port}/redirect-to-disallowed`;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    const bundleContent = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const bundlePath = path.join(tmpDir, 'hostile-source.mjs');
    await fs.writeFile(bundlePath, bundleContent);
    await fs.writeFile(
      path.join(tmpDir, 'test-config.json'),
      JSON.stringify({ allowedTestUrl, redirectToDisallowedUrl }),
    );

    sandboxed = spawnSandboxedSource(
      {
        id: 'hostile-test-source',
        name: 'Hostile Test Source',
        lang: 'en',
        base_url: 'https://example.invalid',
        isNSFW: false,
      },
      { bundlePath, allowedNetHosts: ['127.0.0.1'], timeoutMs: 15000 },
    );

    // Metadata is plain data; no IPC round-trip needed.
    expect(sandboxed.id).toBe('hostile-test-source');

    const results = (await sandboxed.fetchManga()) as unknown as Record<string, unknown>;

    // 1. Scrubbed environment — the child never saw this process's env at all.
    expect(results.envSecret).toBeNull();

    // 2. Filesystem read outside the bundle's own directory is denied by Node's
    // permission model, not merely "the fixture chose not to try."
    expect(results.readOutside).toBeNull();
    expect(results.readOutsideErrorCode).toBe('ERR_ACCESS_DENIED');

    // 3. A request to an allowlisted host is proxied through and actually succeeds.
    expect(results.allowedFetchStatus).toBe(200);
    expect(results.allowedFetchBody).toBe('hello from the allowed host');

    // 4. A request to a host NOT on the allowlist is denied before any real network
    // attempt — the error names the allowlist check, not a DNS/connection failure.
    expect(results.disallowedFetchSucceeded).toBeUndefined();
    expect(String(results.disallowedFetchError)).toMatch(/not in this source's allowlist/);

    // 5. An allowlisted host redirecting to a disallowed one is blocked at the redirect
    // hop, not silently followed — the regression test for the SSRF-via-redirect bug.
    expect(results.redirectFetchSucceeded).toBeUndefined();
    expect(String(results.redirectFetchError)).toMatch(/not in this source's allowlist/);
  }, 20000);

  it('with an empty allowlist, denies every outbound request — including the one that would otherwise be allowed', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    const bundleContent = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const bundlePath = path.join(tmpDir, 'hostile-source.mjs');
    await fs.writeFile(bundlePath, bundleContent);
    // Points at a real, otherwise-reachable local address — the point is that an empty
    // allowlist denies it anyway, not that the address itself is unreachable.
    await fs.writeFile(
      path.join(tmpDir, 'test-config.json'),
      JSON.stringify({ allowedTestUrl: 'http://127.0.0.1:1/' }),
    );

    sandboxed = spawnSandboxedSource(
      {
        id: 'hostile-test-source',
        name: 'Hostile Test Source',
        lang: 'en',
        base_url: 'https://example.invalid',
        isNSFW: false,
      },
      { bundlePath, allowedNetHosts: [], timeoutMs: 15000 },
    );

    const results = (await sandboxed.fetchManga()) as unknown as Record<string, unknown>;
    expect(results.allowedFetchError).toMatch(/not in this source's allowlist/);
  }, 20000);

  /**
   * The regression this guards is a whole-server crash, not a failed call.
   *
   * A call that outruns its timeout kills the child (see `killChild`), but a proxied fetch
   * the parent started on that child's behalf keeps running — nothing cancels it. When the
   * upstream response finally arrives, the parent tries to deliver it over an IPC channel
   * whose other end is gone. `subprocess.send()` on a closed channel emits `'error'`
   * (ERR_IPC_CHANNEL_CLOSED) on the ChildProcess, and an `'error'` event with no listener
   * is an uncaught exception — so one slow upstream site could take down the entire API
   * process, from ordinary traffic, with no hostile intent required.
   */
  it('survives a proxied response that arrives after the call timeout killed the child', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);

    try {
      // Responds well after the call timeout below, so the reply is guaranteed to land
      // after the child is already dead.
      server = http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('too late');
        }, 1500);
      });
      const port = await new Promise<number>((resolve) => {
        server!.listen(0, '127.0.0.1', () => {
          resolve((server!.address() as { port: number }).port);
        });
      });

      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
      const bundleContent = await fs.readFile(FIXTURE_PATH, 'utf-8');
      const bundlePath = path.join(tmpDir, 'hostile-source.mjs');
      await fs.writeFile(bundlePath, bundleContent);
      await fs.writeFile(
        path.join(tmpDir, 'test-config.json'),
        JSON.stringify({ slowUrl: `http://127.0.0.1:${port}/slow` }),
      );

      sandboxed = spawnSandboxedSource(
        {
          id: 'hostile-test-source',
          name: 'Hostile Test Source',
          lang: 'en',
          base_url: 'https://example.invalid',
          isNSFW: false,
        },
        { bundlePath, allowedNetHosts: ['127.0.0.1'], timeoutMs: 400 },
      );

      // Optional on the `Source` contract, always present on a sandboxed one.
      await expect(sandboxed.fetchMangaThumbnail!('anything')).rejects.toThrow(/too long/);

      // Long enough for the upstream response to arrive and the parent to try to hand it
      // to the child that timing out just killed.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(
        uncaught.map((error) => (error as NodeJS.ErrnoException).code ?? error.message),
      ).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 20000);

  it('forwards a source AbortSignal to the parent and closes the upstream request', async () => {
    let upstreamAborted = false;
    server = http.createServer((req, res) => {
      req.on('aborted', () => {
        upstreamAborted = true;
      });
      res.on('close', () => {
        if (!res.writableEnded) upstreamAborted = true;
      });
      setTimeout(() => {
        if (!res.destroyed) res.end('too late');
      }, 1500);
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-abort-test-'));
    const bundlePath = path.join(tmpDir, 'hostile-source.mjs');
    await fs.copyFile(FIXTURE_PATH, bundlePath);
    await fs.writeFile(
      path.join(tmpDir, 'test-config.json'),
      JSON.stringify({ slowUrl: `http://127.0.0.1:${port}/slow`, signalAbortMs: 100 }),
    );
    sandboxed = spawnSandboxedSource(
      {
        id: 'hostile-abort-source',
        name: 'Hostile Abort Source',
        lang: 'en',
        base_url: 'https://example.invalid',
        isNSFW: false,
      },
      { bundlePath, allowedNetHosts: ['127.0.0.1'], timeoutMs: 15000 },
    );

    await expect(sandboxed.fetchMangaThumbnail!('anything')).rejects.toThrow(/abort/i);
    for (let attempt = 0; attempt < 20 && !upstreamAborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(upstreamAborted).toBe(true);
  }, 20000);

  it('propagates an error thrown inside the sandboxed source back as a rejected promise', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    const bundleContent = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const bundlePath = path.join(tmpDir, 'hostile-source.mjs');
    await fs.writeFile(bundlePath, bundleContent);
    await fs.writeFile(
      path.join(tmpDir, 'test-config.json'),
      JSON.stringify({ allowedTestUrl: 'http://127.0.0.1:1/' }),
    );

    sandboxed = spawnSandboxedSource(
      {
        id: 'hostile-test-source',
        name: 'Hostile Test Source',
        lang: 'en',
        base_url: 'https://example.invalid',
        isNSFW: false,
      },
      { bundlePath, allowedNetHosts: [], timeoutMs: 15000 },
    );

    await expect(sandboxed.fetchMangaDetails('anything')).rejects.toThrow(
      /not implemented in hostile fixture/,
    );
  }, 20000);

  /**
   * The IPC boundary used to forward `error.message` and nothing else, which silently
   * downgraded every repo-installed source: apps/server classifies source failures by
   * matching on `code`/`reason`/`detail` (source.service.ts's `translateSourceError`,
   * updateLog.service.ts's `isClassified`), so a sandboxed source's BLOCKED became a
   * generic 500 where a bundled source produced a 503 and a legible update-log entry.
   */
  describe('classified source errors', () => {
    async function spawnFixture() {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
      const bundleContent = await fs.readFile(FIXTURE_PATH, 'utf-8');
      const bundlePath = path.join(tmpDir, 'hostile-source.mjs');
      await fs.writeFile(bundlePath, bundleContent);
      await fs.writeFile(
        path.join(tmpDir, 'test-config.json'),
        JSON.stringify({ allowedTestUrl: 'http://127.0.0.1:1/' }),
      );

      return spawnSandboxedSource(
        {
          id: 'hostile-test-source',
          name: 'Hostile Test Source',
          lang: 'en',
          base_url: 'https://example.invalid',
          isNSFW: false,
        },
        { bundlePath, allowedNetHosts: [], timeoutMs: 15000 },
      );
    }

    it('carries a SourceError’s code, reason, status and url across the boundary', async () => {
      sandboxed = await spawnFixture();

      const error = await sandboxed.fetchChapters('anything').then(
        () => null,
        (caught: unknown) => caught as Record<string, unknown>,
      );

      expect(error).not.toBeNull();
      expect(error?.message).toBe('Hostile Test Source blocked this request.');
      expect(error?.code).toBe('BLOCKED');
      expect(error?.reason).toBe('Cloudflare challenge');
      expect(error?.detail).toBe('HTTP 403 with a challenge body');
      expect(error?.statusCode).toBe(403);
      expect(error?.url).toBe('https://example.invalid/manga');
      // The fixture defines its own error class, so this only works because the payload
      // is matched structurally and rebuilt here — not passed through by identity.
      expect(error?.sourceId).toBe('hostile-test-source');
    }, 20000);

    it('refuses a code the app does not define, keeping the failure unclassified', async () => {
      sandboxed = await spawnFixture();

      const error = await sandboxed.fetchMangaUpdates('anything').then(
        () => null,
        (caught: unknown) => caught as Record<string, unknown>,
      );

      expect(error).not.toBeNull();
      expect(error?.message).toBe('Made-up classification.');
      // No code means apps/server falls back to a generic 500 — the right outcome for a
      // classification the app has no mapping for, and one a source can't fake its way
      // past by inventing a status.
      expect(error?.code).toBeUndefined();
      expect(error?.statusCode).toBeUndefined();
      expect(error?.reason).toBeUndefined();
    }, 20000);

    it('reports a call that outruns its timeout as TIMEOUT rather than a bare Error', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
      // A bundle that simply never answers — the case the per-call timeout exists for.
      const bundlePath = path.join(tmpDir, 'stalling-source.mjs');
      await fs.writeFile(
        bundlePath,
        `export default {
  id: 'stalling-test-source',
  name: 'Stalling Test Source',
  lang: 'en',
  base_url: 'https://example.invalid',
  isNSFW: false,
  async fetchManga() {
    await new Promise(() => {});
  },
};
`,
      );

      sandboxed = spawnSandboxedSource(
        {
          id: 'stalling-test-source',
          name: 'Stalling Test Source',
          lang: 'en',
          base_url: 'https://example.invalid',
          isNSFW: false,
        },
        { bundlePath, allowedNetHosts: [], timeoutMs: 1000 },
      );

      const error = await sandboxed.fetchManga().then(
        () => null,
        (caught: unknown) => caught as Record<string, unknown>,
      );

      expect(error?.code).toBe('TIMEOUT');
      // The message is what reaches the user, so it must not carry sandbox internals;
      // those belong in `detail`.
      expect(error?.message).toBe('Stalling Test Source took too long to respond. Try again.');
      expect(String(error?.detail)).toMatch(/timed out after 1000ms/);
    }, 20000);
  });
});
