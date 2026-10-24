'use client';

import {
  getHealth,
  getApiBaseUrl,
  listInstalledExtensions,
  getScraperHealth,
  getRecentServerDiagnostics,
  type InstalledExtension,
  type ScraperHealth,
  type ServerDiagnosticEvent,
} from '@projekt-manga/api-client';

/**
 * The "Copy diagnostic report" payload: what a user can paste into a GitHub issue so a
 * bug can be triaged without access to their machine.
 *
 * ## Why this is built the way it is
 *
 * Every field below is written out **explicitly**. Nothing walks an object, spreads a
 * config, or serialises "everything then filters". That is deliberate: a filter has to
 * anticipate every secret, and the one it forgets is the one that ends up in a public
 * issue. An allowlist fails the other way — a field nobody added is simply missing, which
 * is recoverable.
 *
 * Things that must never appear, directly or embedded in a path or URL:
 * TOKEN_ENCRYPTION_KEY, DATABASE_URL credentials, session cookies or ids, tracker access
 * and refresh tokens, and absolute paths containing the user's name.
 *
 * The one field that cannot be allowlisted is the log tail — free-form text from a child
 * process. It is included because it is usually the only thing that explains a failure,
 * and it goes through `scrubText` on the way in. That is the single place regex-based
 * redaction is used, and it is a second line of defence, not the primary one.
 */

/** Shape the desktop main process returns over IPC. Absent in a plain browser. */
export interface DesktopDiagnostics {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  /** Local SQLite cache schema version, and whether its last migration succeeded. */
  localDbVersion: number | null;
  localDbMigrationOk: boolean;
  /** Whether this build supervises its own API/web processes. */
  managedServers: boolean;
  logs: { api: string[]; web: string[]; main: string[] };
}

interface DesktopDiagnosticsBridge {
  diagnostics?: { collect: () => Promise<DesktopDiagnostics> };
}

/** Longest log line kept. A stack trace pasted in full is unreadable in an issue, and a
 * very long line is also the most likely place for an accidentally-serialised blob. */
const MAX_LOG_LINE = 300;
const MAX_LOG_LINES = 40;

/**
 * Removes the credential shapes that realistically appear in this app's logs.
 *
 * Ordered from most to least specific. Each pattern keeps enough context that the line
 * still reads as the same error — replacing the whole line would defeat the purpose.
 */
export function scrubText(input: string): string {
  return (
    input
      // Connection strings: mysql://user:pass@host/db, postgres://…, and the same with
      // no password. Keeps the scheme and host so "which database" is still answerable.
      //
      // `[^\s]*` is greedy on purpose, so it backtracks to the *last* `@` in the URL
      // token. A non-greedy or `[^@]`-bounded userinfo stops at the first `@`, which for a
      // password like `p@ssw0rd` redacts `user:p` and publishes `ssw0rd` — a real leak,
      // not a theoretical one. It cannot cross whitespace, so an unrelated email address
      // later in the same log line is not swallowed.
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s]*@/gi, '$1<redacted>@')

      // Headers whose *entire* value is sensitive, redacted to end of line.
      //
      // These come before the generic rule below because a value pattern that stops at
      // whitespace turns
      // `Authorization: Bearer eyJhbGci…` into `Authorization: <redacted> eyJhbGci…`,
      // redacting the word "Bearer" and publishing the token.
      .replace(/\b((?:set-)?cookie|authorization)(\s*[:=]\s*).*/gi, '$1$2<redacted>')

      // Bearer tokens appearing mid-line rather than as a header value.
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer <redacted>')

      // The session cookie by name (apps/server's SESSION_COOKIE_NAME).
      .replace(/\bpm_session=[^\s;]+/gi, 'pm_session=<redacted>')

      // key=value / key: value where the *name* contains a secret-ish word. The
      // surrounding `[\w.-]*` matters: without it `TOKEN_ENCRYPTION_KEY=…` would not match,
      // because the keyword would have to be the whole identifier.
      .replace(
        /\b[\w.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|encryption[_-]?key|credential|session[_-]?id)[\w.-]*(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)"']+)/gi,
        (match, sep: string) => `${match.slice(0, match.indexOf(sep))}${sep}<redacted>`,
      )

      // Windows and POSIX home directories — these carry the user's real name.
      .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/gi, '~')
      .replace(/\/(?:home|Users)\/[^/\s"']+/g, '~')
  );
}

/** Strips userinfo from a URL, so a repository URL that happens to carry basic-auth
 * credentials cannot travel into an issue. Returns the input unchanged if unparseable —
 * it is displayed, not trusted. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString();
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function scrubLogs(lines: string[]): string[] {
  return lines
    .slice(-MAX_LOG_LINES)
    .map((line) => scrubText(line))
    .map((line) => (line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line));
}

function codeBlock(lines: string[]): string {
  return lines.length === 0 ? '_(empty)_' : ['```', ...lines, '```'].join('\n');
}

/** Everything the report needs, gathered with individual failures tolerated — a report
 * that is missing the scraper section is far more useful than no report at all, and the
 * cases where you most want one are exactly the cases where something is unreachable. */
async function settled<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

function extensionRows(installed: InstalledExtension[] | null): string {
  if (installed === null) return '_Could not read installed extensions._';
  if (installed.length === 0) return '_None installed._';

  return [
    '| Source | Version | Language | Enabled | Updated |',
    '| --- | --- | --- | --- | --- |',
    ...installed.map((e) =>
      ['', e.source_key, e.version, e.lang, e.enabled ? 'yes' : 'no', e.updated_at, ''].join(' | '),
    ),
  ].join('\n');
}

function scraperSection(scraper: ScraperHealth | null): string {
  if (scraper === null) return '_Could not read scraper health._';
  if (scraper.available === false)
    return `- Scraper health unavailable: ${scrubText(scraper.reason ?? 'not included in this build')}`;

  // Explicitly chosen fields. `recentBans` is deliberately reduced to a count: the full
  // entries carry per-title URLs, which is more of the user's reading history than a bug
  // report needs.
  const { hits, misses } = scraper.htmlCache;
  const lookups = hits + misses;
  const hitRate = lookups === 0 ? 'n/a' : `${Math.round((hits / lookups) * 100)}%`;

  return [
    `- Anti-detection enabled: ${scraper.enabled}`,
    `- Proxies: ${scraper.proxy.totalProxies} configured, ${scraper.proxy.healthyProxies} healthy, ${scraper.proxy.coolingDownProxies} cooling down`,
    `- Recent bans recorded: ${scraper.recentBans.length}`,
    `- HTML cache: ${hitRate} hit rate over ${lookups} lookups`,
    `- User-agent profiles: ${scraper.userAgent.profileCount} (remote profile: ${scraper.userAgent.usingRemoteProfile})`,
  ].join('\n');
}

function desktopSection(d: DesktopDiagnostics | null): string {
  if (d === null) {
    return [
      '- Running in: browser (no desktop shell)',
      `- User agent: ${typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent}`,
    ].join('\n');
  }

  return [
    `- App version: ${d.appVersion}`,
    `- Electron: ${d.electronVersion} (Chrome ${d.chromeVersion}, Node ${d.nodeVersion})`,
    `- OS: ${d.platform} ${d.arch} (${d.osRelease})`,
    `- Supervised servers: ${d.managedServers}`,
    `- Local cache schema: v${d.localDbVersion ?? 'unknown'} (last migration ${d.localDbMigrationOk ? 'ok' : 'FAILED'})`,
  ].join('\n');
}

function serverEventsSection(events: ServerDiagnosticEvent[] | null): string[] {
  if (events === null) return ['_Could not read recent server events._'];
  if (events.length === 0) return ['_(No recent server events.)_'];
  return events.slice(-40).map((entry) => {
    const counts = Object.entries(entry.counts)
      .slice(0, 8)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const fields = [entry.at, entry.level.toUpperCase(), entry.area, entry.event];
    if (entry.requestId) fields.push(`request=${entry.requestId}`);
    if (entry.jobId) fields.push(`job=${entry.jobId}`);
    if (entry.code) fields.push(`code=${entry.code}`);
    if (counts) fields.push(counts);
    return scrubText(fields.join(' ')).slice(0, 300);
  });
}

/**
 * Builds the pasteable report. Never throws: a diagnostic tool that fails when the app is
 * broken is useless precisely when it is needed.
 */
export async function buildDiagnosticReport(): Promise<string> {
  const bridge = (window as unknown as { desktop?: DesktopDiagnosticsBridge }).desktop;

  const [desktop, health, installed, scraper, serverEvents] = await Promise.all([
    bridge?.diagnostics ? settled(bridge.diagnostics.collect()) : Promise.resolve(null),
    settled(getHealth()),
    settled(listInstalledExtensions()),
    settled(getScraperHealth()),
    settled(getRecentServerDiagnostics()),
  ]);

  const sections = [
    '## Projekt Manga diagnostic report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '### Environment',
    desktopSection(desktop),
    '',
    '### Server',
    `- API base URL: ${redactUrl(getApiBaseUrl())}`,
    `- Reachable: ${health ? 'yes' : 'no'}`,
    '',
    '### Installed sources',
    extensionRows(installed),
    '',
    '### Scraper health',
    scraperSection(scraper),
    '',
    '### Recent server events',
    codeBlock(serverEventsSection(serverEvents)),
  ];

  if (desktop) {
    sections.push(
      '',
      '### Recent API log',
      codeBlock(scrubLogs(desktop.logs.api)),
      '',
      '### Recent web log',
      codeBlock(scrubLogs(desktop.logs.web)),
    );
    if (desktop.logs.main.length > 0) {
      sections.push('', '### Recent shell log', codeBlock(scrubLogs(desktop.logs.main)));
    }
  }

  return sections.join('\n');
}
