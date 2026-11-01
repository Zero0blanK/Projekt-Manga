import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopDiagnostics } from '@/lib/diagnostics';

vi.mock('@projekt-manga/api-client', async (importOriginal) => importOriginal());

const { likelyProblems } = await import('@/lib/diagnostics');
const { installClientDiagnostics, readClientDiagnostics, resetClientDiagnosticsForTests } =
  await import('@/lib/client-diagnostics');
const { request } = await import('@projekt-manga/api-client');

function desktop(overrides: Partial<DesktopDiagnostics> = {}): DesktopDiagnostics {
  return {
    appVersion: '1.0.0',
    electronVersion: '43.8.0',
    chromeVersion: '150',
    nodeVersion: '24.22.0',
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.26300',
    localDbVersion: 5,
    localDbMigrationOk: true,
    managedServers: true,
    logs: { api: [], web: [], main: [] },
    ...overrides,
  };
}

const baseInput = {
  reachable: true,
  runtime: null,
  requests: [],
  errors: [],
  sourceHealth: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetClientDiagnosticsForTests();
});

describe('likely problems', () => {
  it('names the crashed API and the missing package from a 1.0.0 installer report', () => {
    const problems = likelyProblems({
      ...baseInput,
      reachable: false,
      desktop: desktop({
        servers: {
          api: {
            started: true,
            running: false,
            uptimeSeconds: null,
            exitCode: 1,
            exitSignal: null,
            ready: false,
            readyError: null,
            usingBundledNode: true,
          },
          web: {
            started: true,
            running: true,
            uptimeSeconds: 40,
            exitCode: null,
            exitSignal: null,
            ready: true,
            readyError: null,
            usingBundledNode: true,
          },
        },
        logs: {
          api: [
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tldts' imported from C:\\projekt manga\\resources\\server\\cookieJar.js",
          ],
          web: [],
          main: [],
        },
      }),
      requests: [
        {
          at: '2026-11-01T09:35:00.000Z',
          method: 'GET',
          path: '/source/sources',
          status: 500,
          kind: 'http',
          durationMs: 12,
          message: 'Request failed with status 500',
          fromApi: false,
        },
      ],
    });

    expect(problems.join('\n')).toMatch(/API server exited \(code 1\)/);
    expect(problems.join('\n')).toContain('cannot load "tldts"');
    expect(problems.join('\n')).toMatch(/1 request\(s\) failed with 500 and no API response/);
  });

  it('reports a local cache that a newer build upgraded', () => {
    const problems = likelyProblems({
      ...baseInput,
      desktop: desktop({
        localDbVersion: null,
        localDbMigrationOk: false,
        localDbError:
          'This local database was created by a newer version of Projekt Manga (schema 5, this app supports up to 4).',
      }),
    });
    expect(problems.join('\n')).toContain('created by a newer version');
  });

  it('says nothing stands out for a healthy report', () => {
    expect(likelyProblems({ ...baseInput, desktop: desktop() })).toEqual([]);
  });
});

describe('client request failures', () => {
  it('records a failed request with its status, request id and whether the API answered', async () => {
    installClientDiagnostics();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>Internal Server Error</html>', {
            status: 500,
            headers: { 'X-Request-Id': '123e4567-e89b-42d3-a456-426614174000' },
          }),
      ),
    );

    await expect(request('/chapter/recent?limit=5')).rejects.toThrow('status 500');

    const [failure] = readClientDiagnostics().requests;
    expect(failure).toMatchObject({
      method: 'GET',
      path: '/chapter/recent',
      status: 500,
      fromApi: false,
      requestId: '123e4567-e89b-42d3-a456-426614174000',
    });
  });

  it('marks an API envelope error as coming from the API', async () => {
    installClientDiagnostics();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: false, message: 'Boom', code: 'DATABASE_ERROR' }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    await expect(request('/library')).rejects.toThrow('Boom');
    expect(readClientDiagnostics().requests.at(-1)).toMatchObject({
      fromApi: true,
      code: 'DATABASE_ERROR',
    });
  });
});
