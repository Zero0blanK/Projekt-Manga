import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface FixtureRoute {
  /** Matched against the request pathname (no query string). */
  match: (pathname: string) => boolean;
  /** Path to the fixture file, relative to the `fixturesDir` passed to
   * startFixtureServer(). */
  file: string;
}

export interface FixtureServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

/** A tiny local HTTP server that replays captured fixture files by request path, so
 * characterization tests exercise each source's real fetch + parse code paths without
 * touching the network. Sources are pointed at it via the EXT_SOURCE_<NAME>_BASE_URL env
 * override that config/source.config.ts already supports.
 *
 * `fixturesDir` is an absolute path (typically `path.join(import.meta.dirname,
 * 'fixtures')` from the calling test file) — kept explicit rather than hardcoded here so
 * each source's colocated tests (sources/<name>/__tests__/) own their fixtures directory
 * directly, the way an independently installed extension's tests would. */
export function startFixtureServer(
  fixturesDir: string,
  routes: FixtureRoute[],
): Promise<FixtureServerHandle> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = routes.find((r) => r.match(url.pathname));

    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`No fixture route for ${url.pathname}`);
      return;
    }

    const filePath = path.join(fixturesDir, route.file);
    const contentType = filePath.endsWith('.json') ? 'application/json' : 'text/html';
    const body = readFileSync(filePath, 'utf-8');

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
