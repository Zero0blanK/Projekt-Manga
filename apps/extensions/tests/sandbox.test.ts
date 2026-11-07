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
import { spawnSandboxedSource, CookieJar } from '../dist/sandbox/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sandbox', 'hostile-source.mjs');
const COOKIE_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sandbox', 'cookie-probe-source.mjs');

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

    // It could not signal this process, and the malformed messages it sent were ignored:
    // getting here at all means neither took the parent down.
    expect(results.killSucceeded).toBeUndefined();
    expect(results._killSucceeded).toBeUndefined();
    expect(String(results.killError)).toMatch(/cannot signal/);

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

  /**
   * The browser session (Cloudflare clearance, a login) belongs to the parent. A hostile
   * bundle that could read it could replay it from anywhere, so it is added to requests
   * here, only for allowlisted hosts, and `Set-Cookie` is consumed here rather than
   * forwarded.
   */
  describe('browser session cookies', () => {
    async function startEchoServer(): Promise<number> {
      server = http.createServer((req, res) => {
        if (req.url === '/redirect-out') {
          res.writeHead(302, {
            Location: 'http://localhost:1/collect',
            'Set-Cookie': 'hop=1; Path=/',
          });
          res.end();
          return;
        }
        if (req.url === '/challenge') {
          res.writeHead(403, {
            'Content-Type': 'text/html',
            Server: 'cloudflare',
            'cf-mitigated': 'challenge',
          });
          res.end('<html><head><title>Just a moment...</title></head></html>');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['fresh=abc; Path=/; HttpOnly', 'other=def; Path=/'],
        });
        res.end(
          JSON.stringify({
            cookie: req.headers.cookie ?? null,
            userAgent: req.headers['user-agent'] ?? null,
          }),
        );
      });
      return new Promise<number>((resolve) => {
        server!.listen(0, '127.0.0.1', () => {
          resolve((server!.address() as { port: number }).port);
        });
      });
    }

    async function writeProbe(config: object): Promise<string> {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
      const bundlePath = path.join(tmpDir, 'cookie-probe-source.mjs');
      await fs.copyFile(COOKIE_FIXTURE_PATH, bundlePath);
      await fs.writeFile(path.join(tmpDir, 'test-config.json'), JSON.stringify(config));
      return bundlePath;
    }

    const probeMetadata = {
      id: 'cookie-probe-source',
      name: 'Cookie Probe Source',
      lang: 'en',
      base_url: 'https://example.invalid',
      isNSFW: false,
    };

    it('adds the session cookie and User-Agent for allowlisted hosts only, and the child never sees a cookie', async () => {
      const port = await startEchoServer();
      const base = `http://127.0.0.1:${port}`;
      const bundlePath = await writeProbe({
        urls: [`${base}/echo`, `${base}/redirect-out`, `http://localhost:${port}/echo`],
      });

      const jar = new CookieJar([
        {
          name: 'cf_clearance',
          value: 'secret-clearance',
          domain: '127.0.0.1',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: true,
        },
      ]);
      const consultedHosts: string[] = [];
      const receivedFrom: string[] = [];
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['127.0.0.1'],
        timeoutMs: 15000,
        browserSession: {
          headersFor(url: URL) {
            consultedHosts.push(url.hostname);
            return { cookie: jar.cookieHeader(url), userAgent: 'Browser-UA/1.0' };
          },
          receiveSetCookies(url: URL, setCookies: string[]) {
            receivedFrom.push(url.hostname);
            jar.setCookies(url, setCookies);
          },
        },
      });

      const results = (await sandboxed.fetchManga()) as unknown as Array<{
        url: string;
        status?: number;
        headerNames?: string[];
        setCookie?: string | null;
        body?: string;
        error?: string;
      }>;

      const [allowed, redirected, disallowed] = results;
      // The upstream got the session cookie (beside the source's own) and the browser's UA.
      expect(JSON.parse(allowed.body!)).toEqual({
        cookie: 'own=1; cf_clearance=secret-clearance',
        userAgent: 'Browser-UA/1.0',
      });
      // ...but the child saw neither the cookie it sent nor the ones the server set.
      expect(allowed.setCookie).toBeNull();
      expect(allowed.headerNames).not.toContain('set-cookie');
      expect(JSON.stringify(results)).not.toMatch(/fresh=abc|other=def|hop=1/);

      // A redirect off the allowlist is refused before any request leaves, so the cookie
      // cannot follow it; a disallowed host is never consulted for one either.
      expect(redirected.error).toMatch(/not in this source's allowlist/);
      expect(disallowed.error).toMatch(/not in this source's allowlist/);
      expect(new Set(consultedHosts)).toEqual(new Set(['127.0.0.1']));
      expect(new Set(receivedFrom)).toEqual(new Set(['127.0.0.1']));

      // Set-Cookie (including the one on the redirect hop) went into the parent's jar.
      expect(jar.cookieHeader(new URL(`${base}/`))).toContain('fresh=abc');
      expect(jar.cookieHeader(new URL(`${base}/`))).toContain('hop=1');
    }, 20000);

    it('strips Set-Cookie from what the child receives even without a browser session', async () => {
      const port = await startEchoServer();
      const bundlePath = await writeProbe({ urls: [`http://127.0.0.1:${port}/echo`] });
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['127.0.0.1'],
        timeoutMs: 15000,
      });

      const [result] = (await sandboxed.fetchManga()) as unknown as Array<{
        setCookie: string | null;
        body: string;
      }>;
      expect(result.setCookie).toBeNull();
      expect(JSON.parse(result.body)).toEqual({ cookie: 'own=1', userAgent: 'probe-ua' });
    }, 20000);

    it('reports a call that hit a Cloudflare challenge as CHALLENGE_REQUIRED', async () => {
      const port = await startEchoServer();
      const bundlePath = await writeProbe({
        urls: [],
        challengeUrl: `http://127.0.0.1:${port}/challenge`,
      });
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['127.0.0.1'],
        timeoutMs: 15000,
      });

      const error = await sandboxed.fetchChapters('anything').then(
        () => null,
        (caught: unknown) => caught as Record<string, unknown>,
      );
      expect(error?.code).toBe('CHALLENGE_REQUIRED');
      expect(error?.reason).toBe('Cloudflare challenge');
      expect(error?.detail).toBe('Unexpected status 403');
      expect(error?.url).toBe(`http://127.0.0.1:${port}/challenge`);
    }, 20000);

    it("keeps another call's own error when only one call hit the challenge", async () => {
      const port = await startEchoServer();
      const bundlePath = await writeProbe({
        urls: [],
        challengeUrl: `http://127.0.0.1:${port}/challenge`,
        failAfterMs: 1500,
      });
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['127.0.0.1'],
        timeoutMs: 15000,
      });

      const caught = (call: Promise<unknown>) =>
        call.then(
          () => null,
          (error: unknown) => error as Record<string, unknown>,
        );
      // Both start together; the challenge comes back while the other call is still running.
      const [challenged, gone] = await Promise.all([
        caught(sandboxed.fetchChapters('anything')),
        caught(sandboxed.fetchChapterPages('anything')),
      ]);
      expect(challenged?.code).toBe('CHALLENGE_REQUIRED');
      expect(gone?.code).not.toBe('CHALLENGE_REQUIRED');
      expect(String(gone?.detail ?? gone?.message)).toContain('Chapter is gone');
    }, 20000);
  });

  /**
   * The operator's User-Agent and DNS over HTTPS change how a request goes out, never
   * whether it may: the allowlist still runs on the hostname, and the public-address check
   * still runs on every address the resolver returns.
   */
  describe('network settings', () => {
    type ProbeResult = { url: string; status?: number; body?: string; error?: string };

    async function writeProbe(config: object): Promise<string> {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
      const bundlePath = path.join(tmpDir, 'cookie-probe-source.mjs');
      await fs.copyFile(COOKIE_FIXTURE_PATH, bundlePath);
      await fs.writeFile(path.join(tmpDir, 'test-config.json'), JSON.stringify(config));
      return bundlePath;
    }

    async function startEchoServer(): Promise<number> {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            userAgent: req.headers['user-agent'] ?? null,
            evil: req.headers['x-evil'] ?? null,
          }),
        );
      });
      return new Promise<number>((resolve) => {
        server!.listen(0, '127.0.0.1', () => {
          resolve((server!.address() as { port: number }).port);
        });
      });
    }

    const probeMetadata = {
      id: 'network-probe-source',
      name: 'Network Probe Source',
      lang: 'en',
      base_url: 'https://example.invalid',
      isNSFW: false,
    };

    /** The server's guard, reduced: IP literals in private ranges are refused, and so is
     * any hostname, standing in for system DNS that cannot (or must not) resolve it. */
    function publicLiteralOnly(url: URL): boolean {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!/^[\d.]+$/.test(host) && !host.includes(':')) return false;
      return !/^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(host) && host !== '::1';
    }

    function dohAnswer(addresses: Record<string, { A?: string[]; AAAA?: string[] }>) {
      return (url: URL) => {
        const name = url.searchParams.get('name') ?? '';
        const type = url.searchParams.get('type') as 'A' | 'AAAA';
        const data = addresses[name]?.[type] ?? [];
        return new Response(
          JSON.stringify({
            Status: addresses[name] ? 0 : 3,
            Answer: data.map((address) => ({
              name,
              type: type === 'A' ? 1 : 28,
              TTL: 60,
              data: address,
            })),
          }),
          { headers: { 'content-type': 'application/dns-json' } },
        );
      };
    }

    it('sends the operator User-Agent without letting a disallowed or private host through', async () => {
      const port = await startEchoServer();
      const bundlePath = await writeProbe({
        urls: [
          `http://127.0.0.1:${port}/echo`,
          `http://not-on-the-allowlist.test:${port}/`,
          `http://private.test:${port}/`,
        ],
      });
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['127.0.0.1', 'private.test'],
        timeoutMs: 15000,
        // 127.0.0.1 stands in for a public host here; private.test for one resolving inward.
        validateOutboundUrl: (url: URL) => url.hostname !== 'private.test',
        networkSettings: () => ({ userAgent: 'Operator-UA/2.0' }),
      });

      const [allowed, disallowed, privateHost] =
        (await sandboxed.fetchManga()) as unknown as ProbeResult[];
      expect(JSON.parse(allowed.body!)).toEqual({ userAgent: 'Operator-UA/2.0', evil: null });
      expect(disallowed.error).toMatch(/not in this source's allowlist/);
      expect(privateHost.error).toMatch(/Blocked by outbound URL validation/);
    }, 20000);

    it('ignores a User-Agent that could inject a header', async () => {
      const port = await startEchoServer();
      const bundlePath = await writeProbe({ urls: [`http://127.0.0.1:${port}/echo`] });
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['127.0.0.1'],
        timeoutMs: 15000,
        networkSettings: () => ({ userAgent: 'Operator\r\nX-Evil: 1' }),
      });
      const [result] = (await sandboxed.fetchManga()) as unknown as ProbeResult[];
      expect(JSON.parse(result.body!)).toEqual({ userAgent: 'probe-ua', evil: null });
    }, 20000);

    it('resolves over DoH, pins the validated address, and refuses private answers and disallowed hosts', async () => {
      const bundlePath = await writeProbe({
        urls: [
          'http://manga.test/chapter',
          'http://evil.test/',
          'http://mixed.test/',
          'http://other.test/',
          'http://manga.test/redirect',
          'http://nowhere.test/',
        ],
      });
      const dohQueries: string[] = [];
      const upstream: Array<{ host: string; pin: unknown; userAgent: string | null }> = [];
      const resolver = dohAnswer({
        'manga.test': { A: ['93.184.216.34'] },
        'evil.test': { A: ['169.254.169.254'] },
        'mixed.test': { A: ['93.184.216.34'], AAAA: ['::1'] },
        'other.test': { A: ['93.184.216.34'] },
      });
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['manga.test', 'evil.test', 'mixed.test', 'nowhere.test'],
        timeoutMs: 15000,
        validateOutboundUrl: publicLiteralOnly,
        fetchImpl: async (url: URL, init: RequestInit, pin?: unknown) => {
          if (url.hostname === 'doh.test') {
            dohQueries.push(url.searchParams.get('name') ?? '');
            return resolver(url);
          }
          upstream.push({
            host: url.hostname,
            pin,
            userAgent: new Headers(init.headers).get('user-agent'),
          });
          if (url.pathname === '/redirect') {
            return new Response(null, { status: 302, headers: { location: 'http://evil.test/' } });
          }
          return new Response('ok');
        },
        networkSettings: () => ({
          dohUrl: 'https://doh.test/dns-query',
          userAgent: 'Operator-UA/2.0',
        }),
      });

      const [manga, evil, mixed, other, redirect, nowhere] =
        (await sandboxed.fetchManga()) as unknown as ProbeResult[];
      expect(manga).toMatchObject({ status: 200, body: 'ok' });
      expect(evil.error).toMatch(/Blocked by outbound URL validation/);
      expect(mixed.error).toMatch(/Blocked by outbound URL validation/);
      expect(other.error).toMatch(/not in this source's allowlist/);
      expect(redirect.error).toMatch(/Blocked by outbound URL validation/);
      expect(nowhere.error).toMatch(/DNS over HTTPS lookup failed for nowhere\.test/);
      // The resolver URL never appears in what the child sees.
      expect(JSON.stringify([evil, mixed, nowhere])).not.toContain('doh.test');

      // Only validated, allowlisted hosts were contacted, each pinned to its checked address.
      const pinned = { address: '93.184.216.34', family: 4 };
      expect(upstream).toEqual([
        { host: 'manga.test', pin: pinned, userAgent: 'Operator-UA/2.0' },
        { host: 'manga.test', pin: pinned, userAgent: 'Operator-UA/2.0' },
      ]);
      // A disallowed host is refused before the resolver is even asked.
      expect(dohQueries).not.toContain('other.test');
    }, 20000);

    it('refuses requests when DoH is on but nothing can validate and pin the answer', async () => {
      const bundlePath = await writeProbe({ urls: ['http://manga.test/'] });
      sandboxed = spawnSandboxedSource(probeMetadata, {
        bundlePath,
        allowedNetHosts: ['manga.test'],
        timeoutMs: 15000,
        networkSettings: () => ({ dohUrl: 'https://doh.test/dns-query' }),
      });
      const [result] = (await sandboxed.fetchManga()) as unknown as ProbeResult[];
      expect(result.error).toMatch(/DNS over HTTPS needs outbound URL validation/);
    }, 20000);
  });
});
