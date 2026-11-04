'use client';

import {
  getHealth,
  getApiBaseUrl,
  listInstalledExtensions,
  getScraperHealth,
  getRecentServerDiagnostics,
  getServerRuntimeDiagnostics,
  getSourceHealth,
  type InstalledExtension,
  type RequestFailure,
  type ScraperHealth,
  type ServerDiagnosticEvent,
  type ServerRuntimeDiagnostics,
  type SourceHealth,
} from '@projekt-manga/api-client';
import {
  readClientDiagnostics,
  type ClientErrorEvent,
  type PageVisit,
} from '@/lib/client-diagnostics';

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

/** One supervised server child, as main/servers.ts reports it. */
export interface DesktopServerStatus {
  started: boolean;
  running: boolean;
  uptimeSeconds: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  ready: boolean;
  readyError: string | null;
  usingBundledNode: boolean;
}

/** Shape the desktop main process returns over IPC. Absent in a plain browser. Fields
 * after `managedServers` are optional because an older desktop shell does not send them. */
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
  localDbError?: string | null;
  /** Whether this build supervises its own API/web processes. */
  managedServers: boolean;
  packaged?: boolean;
  osVersion?: string | null;
  locale?: string | null;
  uptimeSeconds?: { app: number; system: number };
  memory?: { systemTotalMb: number; systemFreeMb: number; appProcessesMb: number };
  cpu?: { model: string; cores: number } | null;
  processes?: Array<{ type: string; memoryMb: number; cpuPercent: number }>;
  gpu?: Record<string, string> | null;
  displays?: Array<{ width: number; height: number; scaleFactor: number; primary: boolean }>;
  storage?: {
    freeGb: number | null;
    totalGb: number | null;
    serverDbMb: number | null;
    localCacheMb: number | null;
    installedSourceBundles: number | null;
  };
  servers?: Record<'api' | 'web', DesktopServerStatus> | null;
  update?: {
    status: string;
    availableVersion: string | null;
    error: string | null;
  } | null;
  settings?: {
    closeToTray: boolean;
    hideFromCapture: boolean;
    appLock: boolean;
    signedIn: boolean;
  } | null;
  startupErrors?: Array<{ at: string; stage: string; message: string }>;
  logs: { api: string[]; web: string[]; main: string[] };
}

interface DesktopDiagnosticsBridge {
  diagnostics?: { collect: () => Promise<DesktopDiagnostics> };
}

/** Longest log line kept. A stack trace pasted in full is unreadable in an issue, and a
 * very long line is also the most likely place for an accidentally-serialised blob. */
const MAX_LOG_LINE = 600;
const MAX_LOG_LINES = 150;

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

const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? 'unknown' : value ? 'yes' : 'no';

function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** A table whose every cell is scrubbed, with pipes escaped so a value cannot break it. */
function table(headers: string[], rows: Array<Array<string | number | boolean | null>>): string {
  const cell = (value: string | number | boolean | null) =>
    scrubText(value === null ? '—' : String(value))
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

/** Reads without assuming any browser API exists: the report runs in tests with a bare
 * window, and in the cases worth reporting something may well be broken. */
function read<T>(get: () => T | undefined): T | null {
  try {
    return get() ?? null;
  } catch {
    return null;
  }
}

async function browserFacts(): Promise<string[]> {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const media = (query: string) =>
    read(() =>
      typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : undefined,
    );
  let storage: StorageEstimate | null = null;
  try {
    storage = (await nav?.storage?.estimate?.()) ?? null;
  } catch {
    // Unavailable, e.g. in a private window.
  }
  const heap = read(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
        .memory,
  );
  const mb = (bytes: number | undefined) =>
    bytes === undefined ? 'unknown' : `${Math.round(bytes / 1024 / 1024)} MB`;
  const dark = media('(prefers-color-scheme: dark)');
  return [
    `- User agent: ${nav?.userAgent ?? 'unknown'}`,
    `- Languages: ${read(() => nav?.languages?.join(', ')) ?? nav?.language ?? 'unknown'}`,
    `- Time zone: ${read(() => Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'unknown'}`,
    `- Online: ${yesNo(nav?.onLine)}`,
    `- Viewport: ${read(() => (window.innerWidth ? `${window.innerWidth}×${window.innerHeight}` : undefined)) ?? 'unknown'} at ${read(() => window.devicePixelRatio) ?? '?'}x`,
    `- Colour scheme: ${dark === null ? 'unknown' : dark ? 'dark' : 'light'}, reduced motion: ${yesNo(media('(prefers-reduced-motion: reduce)'))}`,
    `- CPU threads: ${nav?.hardwareConcurrency ?? 'unknown'}, device memory: ${read(() => (nav as unknown as { deviceMemory?: number } | null)?.deviceMemory) ?? 'unknown'} GB`,
    `- JS heap: ${heap ? `${mb(heap.usedJSHeapSize)} of ${mb(heap.jsHeapSizeLimit)}` : 'unknown'}`,
    `- Site storage: ${storage ? `${mb(storage.usage)} used of ${mb(storage.quota)}` : 'unknown'}`,
  ];
}

function desktopSection(d: DesktopDiagnostics | null): string[] {
  if (d === null) return ['- Running in: browser (no desktop shell)'];
  const lines = [
    `- App version: ${d.appVersion}${d.packaged === false ? ' (unpackaged development run)' : ''}`,
    `- Electron: ${d.electronVersion} (Chrome ${d.chromeVersion}, Node ${d.nodeVersion})`,
    `- OS: ${d.osVersion ? `${d.osVersion}, ` : ''}${d.platform} ${d.arch} (${d.osRelease})`,
  ];
  if (d.locale) lines.push(`- Locale: ${d.locale}`);
  if (d.uptimeSeconds)
    lines.push(
      `- Uptime: app ${duration(d.uptimeSeconds.app)}, system ${duration(d.uptimeSeconds.system)}`,
    );
  if (d.cpu) lines.push(`- CPU: ${d.cpu.model} (${d.cpu.cores} threads)`);
  if (d.memory)
    lines.push(
      `- Memory: ${d.memory.systemFreeMb} MB free of ${d.memory.systemTotalMb} MB; this app uses ${d.memory.appProcessesMb} MB`,
    );
  if (d.displays?.length)
    lines.push(
      `- Displays: ${d.displays
        .map((s) => `${s.width}×${s.height}@${s.scaleFactor}x${s.primary ? ' (primary)' : ''}`)
        .join(', ')}`,
    );
  lines.push(
    `- Supervised servers: ${d.managedServers}`,
    `- Local cache schema: v${d.localDbVersion ?? 'unknown'} (last migration ${d.localDbMigrationOk ? 'ok' : 'FAILED'})`,
  );
  if (d.localDbError) lines.push(`- Local cache error: ${scrubText(d.localDbError)}`);
  if (d.storage) {
    const s = d.storage;
    lines.push(
      `- Disk: ${s.freeGb ?? '?'} GB free of ${s.totalGb ?? '?'} GB`,
      `- Data sizes: server database ${s.serverDbMb ?? 'none'} MB, local cache ${s.localCacheMb ?? 'none'} MB, ${s.installedSourceBundles ?? 'unknown'} installed source bundles`,
    );
  }
  if (d.update)
    lines.push(
      `- Updates: ${d.update.status}${d.update.availableVersion ? ` (offering ${d.update.availableVersion})` : ''}${d.update.error ? `, last error: ${scrubText(d.update.error)}` : ''}`,
    );
  if (d.settings)
    lines.push(
      `- Settings: signed in ${yesNo(d.settings.signedIn)}, app lock ${yesNo(d.settings.appLock)}, close to tray ${yesNo(d.settings.closeToTray)}, hidden from capture ${yesNo(d.settings.hideFromCapture)}`,
    );
  return lines;
}

function serverProcessSection(d: DesktopDiagnostics | null): string | null {
  if (!d?.servers) return null;
  const row = (name: string, s: DesktopServerStatus) => [
    name,
    s.running ? 'running' : s.started ? 'exited' : 'not started',
    s.ready ? 'yes' : s.readyError ? `no: ${s.readyError}` : 'not yet',
    duration(s.uptimeSeconds),
    s.exitCode ?? s.exitSignal ?? null,
    s.usingBundledNode ? 'bundled' : 'Electron',
  ];
  return table(
    ['Process', 'State', 'Port ready', 'Uptime', 'Exit', 'Node'],
    [row('API', d.servers.api), row('Web', d.servers.web)],
  );
}

function processTable(d: DesktopDiagnostics | null): string | null {
  if (!d?.processes?.length) return null;
  return table(
    ['Process', 'Memory (MB)', 'CPU %'],
    d.processes.map((p) => [p.type, p.memoryMb, p.cpuPercent]),
  );
}

function gpuLine(d: DesktopDiagnostics | null): string | null {
  if (!d?.gpu) return null;
  // Only the features that are not plainly enabled: the full list is long and mostly noise.
  const notable = Object.entries(d.gpu).filter(([, status]) => !/^enabled/.test(status));
  return notable.length === 0
    ? '- GPU features: all enabled'
    : `- GPU features not fully enabled: ${notable.map(([k, v]) => `${k}=${v}`).join(', ')}`;
}

function runtimeSection(runtime: ServerRuntimeDiagnostics | null): string[] {
  if (runtime === null)
    return ['- Runtime details: unavailable (server unreachable, or this client is not an admin)'];
  const counts = Object.entries(runtime.counts)
    .map(([key, value]) => `${key} ${value ?? 'unreadable'}`)
    .join(', ');
  const downloads = runtime.downloads
    ? Object.entries(runtime.downloads)
        .map(([status, n]) => `${status.toLowerCase()} ${n}`)
        .join(', ') || 'none'
    : 'unreadable';
  const features = Object.entries(runtime.features)
    .map(([key, value]) => `${key} ${typeof value === 'boolean' ? yesNo(value) : (value ?? 'no')}`)
    .join(', ');
  const m = runtime.migrations;
  return [
    `- Node: ${runtime.node} on ${runtime.platform} (${runtime.nodeEnv ?? 'no NODE_ENV'})`,
    `- Uptime: ${duration(runtime.uptimeSeconds)}`,
    `- Memory: ${runtime.memoryMb.rss} MB resident, heap ${runtime.memoryMb.heapUsed}/${runtime.memoryMb.heapTotal} MB`,
    m
      ? `- Migrations: ${m.applied} applied, latest ${m.latest ?? 'none'}${m.failed ? `, ${m.failed} FAILED` : ''}`
      : '- Migrations: could not read the migrations table',
    `- Rows: ${counts}`,
    `- Downloads: ${downloads}`,
    `- Configured: ${features}`,
  ];
}

function sourceHealthSection(health: SourceHealth[] | null): string {
  if (health === null) return '_Could not read source health._';
  const rows = health.filter(
    (h) => h.browse?.lastErrorCode || h.update?.lastErrorCode || h.browse?.retryAfterAt,
  );
  if (rows.length === 0) return `_No source reports a recent failure (${health.length} tracked)._`;
  return table(
    ['Source', 'Browse error', 'Update error', 'Retry after'],
    rows.map((h) => [
      h.sourceId,
      h.browse?.lastErrorCode ?? null,
      h.update?.lastErrorCode ?? null,
      h.browse?.retryAfterAt ?? h.update?.retryAfterAt ?? null,
    ]),
  );
}

function requestsSection(requests: RequestFailure[]): string {
  if (requests.length === 0) return '_No failed requests since this page loaded._';
  return table(
    ['Time', 'Request', 'Status', 'From API', 'Code', 'Took', 'Request id', 'Message'],
    requests
      .slice(-40)
      .map((r) => [
        r.at.slice(11, 23),
        `${r.method} ${r.path}`,
        r.status === 0 ? r.kind : r.status,
        r.status === 0 ? null : r.fromApi ? 'yes' : 'NO',
        r.code ?? null,
        `${r.durationMs} ms`,
        r.requestId ?? null,
        r.message.slice(0, 160),
      ]),
  );
}

function clientErrorsSection(errors: ClientErrorEvent[]): string {
  if (errors.length === 0) return '_No client errors since this page loaded._';
  return codeBlock(
    scrubLogs(
      errors.flatMap((e) => [
        `${e.at.slice(11, 23)} ${e.kind.toUpperCase()} on ${e.page}: ${e.message}`,
        ...(e.stack ? e.stack.split('\n').map((frame) => `    ${frame.trim()}`) : []),
      ]),
    ),
  );
}

function pagesSection(pages: PageVisit[]): string {
  if (pages.length === 0) return '_(none recorded)_';
  return pages.map((p) => `- ${p.at.slice(11, 19)} ${scrubText(p.page)}`).join('\n');
}

const firstLine = (text: string) => scrubText(text.split('\n')[0] ?? '');

/**
 * The first thing a reader of the report sees: what looks wrong, in plain words, drawn
 * from the sections below. Each rule points at the section that holds its evidence.
 */
export function likelyProblems(input: {
  desktop: DesktopDiagnostics | null;
  reachable: boolean;
  runtime: ServerRuntimeDiagnostics | null;
  requests: RequestFailure[];
  errors: ClientErrorEvent[];
  sourceHealth: SourceHealth[] | null;
}): string[] {
  const { desktop, reachable, runtime, requests, errors, sourceHealth } = input;
  const problems: string[] = [];
  const exitOf = (s: DesktopServerStatus) => s.exitCode ?? s.exitSignal ?? 'unknown';

  const api = desktop?.servers?.api;
  if (api?.started && !api.running)
    problems.push(`The API server exited (code ${exitOf(api)}); "Recent API log" says why.`);
  else if (api && !api.ready && api.readyError)
    problems.push(`The API server never opened its port: ${firstLine(api.readyError)}`);
  const web = desktop?.servers?.web;
  if (web?.started && !web.running)
    problems.push(`The web server exited (code ${exitOf(web)}); "Recent web log" says why.`);

  const apiLog = desktop?.logs.api.join('\n') ?? '';
  const missing = apiLog.match(/Cannot find (?:package|module) '([^']+)'/);
  if (missing)
    problems.push(`The API cannot load "${scrubText(missing[1] ?? '')}" (ERR_MODULE_NOT_FOUND).`);
  if (!reachable) problems.push('The API did not answer its health check.');

  if (desktop && !desktop.localDbMigrationOk)
    problems.push(
      `The local cache could not be opened${desktop.localDbError ? `: ${firstLine(desktop.localDbError)}` : '.'}`,
    );
  for (const startup of desktop?.startupErrors ?? [])
    problems.push(`Start-up step "${startup.stage}" failed: ${firstLine(startup.message)}`);
  if (runtime?.migrations?.failed)
    problems.push(`${runtime.migrations.failed} server database migration(s) did not finish.`);
  if (runtime && Object.values(runtime.counts).some((n) => n === null))
    problems.push('Some server tables could not be read; the database schema may be incomplete.');

  const freeGb = desktop?.storage?.freeGb;
  if (typeof freeGb === 'number' && freeGb < 1)
    problems.push(`The disk is nearly full (${freeGb} GB free).`);
  if (desktop?.update?.error)
    problems.push(`The updater reported: ${firstLine(desktop.update.error)}`);

  const proxied = requests.filter((r) => r.status >= 500 && !r.fromApi);
  if (proxied.length > 0)
    problems.push(
      `${proxied.length} request(s) failed with ${proxied[0]?.status} and no API response: the API was down or unreachable behind the web server.`,
    );
  const serverErrors = requests.filter((r) => r.status >= 500 && r.fromApi);
  if (serverErrors.length > 0)
    problems.push(
      `${serverErrors.length} request(s) failed inside the API (${[...new Set(serverErrors.map((r) => r.code ?? r.status))].join(', ')}); match their request ids in "Recent server events".`,
    );
  const unanswered = requests.filter((r) => r.kind === 'network' || r.kind === 'timeout');
  if (unanswered.length > 0)
    problems.push(`${unanswered.length} request(s) got no answer at all (network or timeout).`);
  const crashes = errors.filter((e) => e.kind !== 'reported');
  if (crashes.length > 0)
    problems.push(`${crashes.length} uncaught error(s) in the page; see "Client errors".`);
  const failingSources =
    sourceHealth?.filter((h) => h.browse?.lastErrorCode || h.update?.lastErrorCode) ?? [];
  if (failingSources.length > 0)
    problems.push(
      `${failingSources.length} source(s) report recent failures; see "Source health".`,
    );

  return problems;
}

/**
 * Builds the pasteable report. Never throws: a diagnostic tool that fails when the app is
 * broken is useless precisely when it is needed.
 */
export async function buildDiagnosticReport(): Promise<string> {
  const bridge = (window as unknown as { desktop?: DesktopDiagnosticsBridge }).desktop;

  const [desktop, health, installed, scraper, serverEvents, runtime, sourceHealth, browser] =
    await Promise.all([
      bridge?.diagnostics ? settled(bridge.diagnostics.collect()) : Promise.resolve(null),
      settled(getHealth()),
      settled(listInstalledExtensions()),
      settled(getScraperHealth()),
      settled(getRecentServerDiagnostics()),
      settled(getServerRuntimeDiagnostics()),
      settled(getSourceHealth()),
      browserFacts().catch(() => ['- Browser facts unavailable']),
    ]);
  // Read after the calls above, so a failure among them is listed too.
  const client = readClientDiagnostics();
  const problems = likelyProblems({
    desktop,
    reachable: health !== null,
    runtime,
    requests: client.requests,
    errors: client.errors,
    sourceHealth,
  });
  const page = read(() => (typeof location === 'undefined' ? undefined : location.pathname));

  const sections = [
    '## Projekt Manga diagnostic report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Page: ${scrubText(page ?? 'unknown')} (open ${duration(client.pageAgeSeconds)})`,
    '',
    '### Likely problems',
    problems.length === 0 ? '_Nothing stands out._' : problems.map((p) => `- ${p}`).join('\n'),
    '',
    '### Environment',
    desktopSection(desktop).join('\n'),
    '',
    '### Browser',
    browser.join('\n'),
  ];

  const servers = serverProcessSection(desktop);
  if (servers) sections.push('', '### Supervised servers', servers);
  const appProcesses = processTable(desktop);
  const gpu = gpuLine(desktop);
  if (appProcesses || gpu) {
    sections.push('', '### App processes');
    if (appProcesses) sections.push(appProcesses);
    if (gpu) sections.push('', gpu);
  }
  if (desktop?.startupErrors?.length)
    sections.push(
      '',
      '### Start-up errors',
      codeBlock(scrubLogs(desktop.startupErrors.map((e) => `${e.at} [${e.stage}] ${e.message}`))),
    );

  sections.push(
    '',
    '### Server',
    `- API base URL: ${redactUrl(getApiBaseUrl())}`,
    `- Reachable: ${health ? 'yes' : 'no'}`,
    ...runtimeSection(runtime),
    '',
    '### Failed requests (this page)',
    requestsSection(client.requests),
    '',
    '### Client errors (this page)',
    clientErrorsSection(client.errors),
    '',
    '### Pages visited',
    pagesSection(client.pages),
    '',
    '### Installed sources',
    extensionRows(installed),
    '',
    '### Source health',
    sourceHealthSection(sourceHealth),
    '',
    '### Scraper health',
    scraperSection(scraper),
    '',
    '### Recent server events',
    codeBlock(serverEventsSection(serverEvents)),
  );

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
