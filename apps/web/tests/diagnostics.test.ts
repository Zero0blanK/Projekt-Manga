import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The diagnostic report is pasted into public GitHub issues. These tests exist to make
 * that safe: they seed a report with realistic secrets and assert none of them survive.
 *
 * The api-client is mocked rather than stubbed at the network layer so the assertions are
 * about the report builder's own output, not about what a server happens to return.
 */

const getHealth = vi.fn();
const getApiBaseUrl = vi.fn();
const listInstalledExtensions = vi.fn();
const getScraperHealth = vi.fn();
const getRecentServerDiagnostics = vi.fn();

vi.mock('@projekt-manga/api-client', () => ({
  getHealth: (...args: unknown[]) => getHealth(...args),
  getApiBaseUrl: (...args: unknown[]) => getApiBaseUrl(...args),
  listInstalledExtensions: (...args: unknown[]) => listInstalledExtensions(...args),
  getScraperHealth: (...args: unknown[]) => getScraperHealth(...args),
  getRecentServerDiagnostics: (...args: unknown[]) => getRecentServerDiagnostics(...args),
}));

const { buildDiagnosticReport, scrubText, redactUrl } = await import('@/lib/diagnostics');

/** Values that must never reach a bug report. Deliberately shaped like the real thing:
 * a 64-hex TOKEN_ENCRYPTION_KEY, a DATABASE_URL with a password, an AniList bearer token,
 * a session cookie, and a Windows home directory carrying a real first name. */
const SECRETS = {
  encryptionKey: 'a3f1c9d84b2e7f0a15c6d93b8e4f7a2c0b9d6e3f1a8c5b2d7e4f9a6c3b0d8e5f',
  dbPassword: 'hunter2-correct-horse',
  dbUrl: 'mysql://projekt:hunter2-correct-horse@localhost:3306/projektmanga_db',
  bearer: 'eyJhbGciOiJIUzI1NiJ9.aVeryLongAniListAccessTokenValue.sIgNaTuRe',
  sessionId: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
  homePath: 'C:\\Users\\april\\AppData\\Local\\projekt-manga\\local.db',
};

function assertNoSecrets(report: string) {
  expect(report).not.toContain(SECRETS.encryptionKey);
  expect(report).not.toContain(SECRETS.dbPassword);
  expect(report).not.toContain(SECRETS.bearer);
  expect(report).not.toContain(SECRETS.sessionId);
  // The account name is the part that identifies a person.
  expect(report).not.toContain('april');
}

beforeEach(() => {
  getHealth.mockResolvedValue({ status: 'ok', timestamp: '', endpoints: [] });
  getApiBaseUrl.mockReturnValue('/api');
  listInstalledExtensions.mockResolvedValue([]);
  getScraperHealth.mockResolvedValue({
    enabled: true,
    proxy: { totalProxies: 0, healthyProxies: 0, coolingDownProxies: 0 },
    htmlCache: { hits: 3, misses: 1 },
    recentBans: [],
    userAgent: { usingRemoteProfile: true, profileCount: 12 },
  });
  getRecentServerDiagnostics.mockResolvedValue([]);
  vi.stubGlobal('window', {} as Window & typeof globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('scrubText', () => {
  it('redacts connection-string credentials but keeps the host', () => {
    const out = scrubText(`P2039 pool timeout connecting to ${SECRETS.dbUrl}`);
    expect(out).not.toContain(SECRETS.dbPassword);
    expect(out).not.toContain('projekt:');
    // Still says which database, which is the whole point of keeping the line.
    expect(out).toContain('localhost:3306/projektmanga_db');
  });

  it('redacts the whole password even when it contains an @', () => {
    // Regression: a userinfo match bounded at the first `@` redacted "user:p" and left
    // "ssw0rd@localhost..." in the report.
    const out = scrubText('P2039 connecting to mysql://user:p@ssw0rd@localhost:3306/projektmanga');
    expect(out).not.toContain('ssw0rd');
    expect(out).toContain('mysql://<redacted>@localhost:3306/projektmanga');
  });

  it('does not swallow an unrelated address later in the line', () => {
    const out = scrubText('connect mysql://u:p@host/db failed, notify admin@example.com');
    expect(out).toContain('admin@example.com');
    expect(out).not.toContain('u:p');
  });

  it('leaves a credential-free URL alone', () => {
    const line = 'fetched https://example.com/index.json ok';
    expect(scrubText(line)).toBe(line);
  });

  it('redacts named secrets in key=value and key: value form', () => {
    const out = scrubText(
      [
        `TOKEN_ENCRYPTION_KEY=${SECRETS.encryptionKey}`,
        `api_key: ${SECRETS.encryptionKey}`,
        `password="${SECRETS.dbPassword}"`,
        `Authorization: Bearer ${SECRETS.bearer}`,
      ].join('\n'),
    );
    expect(out).not.toContain(SECRETS.encryptionKey);
    expect(out).not.toContain(SECRETS.dbPassword);
    expect(out).not.toContain(SECRETS.bearer);
    expect(out).toContain('<redacted>');
  });

  it('redacts the session cookie by name', () => {
    const out = scrubText(`cookie header: pm_session=${SECRETS.sessionId}; Path=/`);
    expect(out).not.toContain(SECRETS.sessionId);
    expect(out).toContain('pm_session=<redacted>');
  });

  it('replaces home directories on Windows and POSIX', () => {
    expect(scrubText(SECRETS.homePath)).not.toContain('april');
    expect(scrubText('/home/april/.config/projekt-manga')).not.toContain('april');
    expect(scrubText('/Users/april/Library/Application Support')).not.toContain('april');
  });

  it('leaves ordinary log lines alone', () => {
    const line = '[Extension Loader] Loaded source: mangadex (MangaDex)';
    expect(scrubText(line)).toBe(line);
  });
});

describe('redactUrl', () => {
  it('strips basic-auth credentials from a repository URL', () => {
    const out = redactUrl('https://user:s3cr3t@example.com/index.json');
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('user');
    expect(out).toContain('example.com/index.json');
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(redactUrl('/api')).toBe('/api');
  });
});

describe('buildDiagnosticReport', () => {
  it('contains no secrets when every source is fully populated', async () => {
    listInstalledExtensions.mockResolvedValue([
      {
        id: 'ext1',
        repository_id: 'repo1',
        source_key: 'examplesource',
        name: 'Example',
        lang: 'en',
        base_url: 'https://example.com',
        is_nsfw: false,
        allowed_hosts: ['example.com'],
        version: '1.2.0',
        entry_url: 'https://user:s3cr3t@example.com/bundle.js',
        source_code_hash: 'abc123',
        installed_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
        enabled: true,
      },
    ]);
    getApiBaseUrl.mockReturnValue('https://admin:letmein@api.example.com/api');

    vi.stubGlobal('window', {
      desktop: {
        diagnostics: {
          collect: async () => ({
            appVersion: '1.0.0',
            electronVersion: '43.4.0',
            chromeVersion: '138',
            nodeVersion: '25.9.0',
            platform: 'win32',
            arch: 'x64',
            osRelease: '10.0.26200',
            localDbVersion: 4,
            localDbMigrationOk: true,
            managedServers: true,
            logs: {
              api: [
                `injected env: TOKEN_ENCRYPTION_KEY=${SECRETS.encryptionKey}`,
                `P2039 pool timeout connecting to ${SECRETS.dbUrl}`,
                `set-cookie: pm_session=${SECRETS.sessionId}`,
              ],
              web: [`error loading ${SECRETS.homePath}`],
              main: [`tracker refresh failed, Authorization: Bearer ${SECRETS.bearer}`],
            },
          }),
        },
      },
    } as unknown as Window & typeof globalThis);

    const report = await buildDiagnosticReport();

    assertNoSecrets(report);
    expect(report).not.toContain('letmein');
    // The API base URL is reported, minus its credentials.
    expect(report).toContain('api.example.com');
    // Still useful: the environment and the installed source survive.
    expect(report).toContain('10.0.26200');
    expect(report).toContain('examplesource');
    expect(report).toContain('1.2.0');
  });

  it('still produces a report when every backend call fails', async () => {
    getHealth.mockRejectedValue(new Error('ECONNREFUSED'));
    listInstalledExtensions.mockRejectedValue(new Error('ECONNREFUSED'));
    getScraperHealth.mockRejectedValue(new Error('ECONNREFUSED'));
    getRecentServerDiagnostics.mockRejectedValue(new Error('ECONNREFUSED'));

    const report = await buildDiagnosticReport();

    expect(report).toContain('Projekt Manga diagnostic report');
    expect(report).toContain('Reachable: no');
    expect(report).toContain('Could not read installed extensions.');
  });

  it('reports the browser case without a desktop bridge', async () => {
    const report = await buildDiagnosticReport();
    expect(report).toContain('browser (no desktop shell)');
    expect(report).not.toContain('Recent API log');
  });

  it('includes only allowlisted recent server event fields', async () => {
    getRecentServerDiagnostics.mockResolvedValue([
      {
        at: '2026-10-10T00:00:00.000Z',
        level: 'warn',
        area: 'download',
        event: 'download.retry_exhausted',
        requestId: 'c3f6b9d4-55af-45f0-9867-265a801acd12',
        jobId: 'download_123',
        code: 'UPSTREAM_ERROR',
        counts: { attempts: 4 },
      },
    ]);

    const report = await buildDiagnosticReport();

    expect(report).toContain('Recent server events');
    expect(report).toContain('request=c3f6b9d4-55af-45f0-9867-265a801acd12');
    expect(report).toContain('attempts=4');
    assertNoSecrets(report);
  });
});
