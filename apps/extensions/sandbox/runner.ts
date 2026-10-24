/**
 * The sandboxed child process entry point. Spawned by spawnSandboxedSource.ts with
 * `--permission` and a filesystem allowlist scoped to exactly this one installed
 * extension's own bundle directory, and deliberately **no** `--allow-net` grant — this
 * process has zero real network access of its own. Before the bundle is ever loaded,
 * this file replaces the global `fetch` with a shim that proxies every call back to the
 * parent over IPC, so the parent (which enforces this source's host allowlist and the
 * existing SSRF guard) decides what actually goes out, not this process.
 *
 * This is the only code that runs inside the restricted process. Any exception the
 * bundle throws — or a bug in this file itself throws — becomes a plain error message
 * back to the parent rather than crashing the *parent* process.
 */
import type {
  Source,
  SourceCapabilities,
  SourceCataloguePage,
  SourcePageRequest,
  FilterValue,
} from '@projekt-manga/types';
import type { SourceErrorCode } from '@projekt-manga/types';
import type {
  SourceCallRequest,
  ChildMessage,
  ParentMessage,
  FetchProxyResponse,
  SerializedSourceError,
} from './types.js';

// Keep runtime helpers here: the child cannot import host files outside its bundle allowlist.
function catalogueError(source: Source, message: string, reason?: string): Error {
  return Object.assign(new Error(message), { code: 'PARSE_ERROR', sourceId: source.id, reason });
}

export async function sourceCapabilities(source: Source): Promise<SourceCapabilities> {
  const declared = source.getCapabilities
    ? await source.getCapabilities()
    : {
        latest: true,
        search: true,
        filters: true,
        languageFilter: false,
        urlSearch: false,
        nativePagination: false,
      };
  return {
    ...declared,
    urlSearch: declared.urlSearch && typeof source.resolveMangaUrl === 'function',
    nativePagination:
      typeof source.fetchMangaPage === 'function' && typeof source.searchMangaPage === 'function',
  };
}

/** Old bundles keep their offset API; the extra row is retained by the next request. */
export async function sourceCataloguePage(
  source: Source,
  search: boolean,
  value?: string,
  pagination: SourcePageRequest = {},
  filters?: Record<string, FilterValue>,
): Promise<SourceCataloguePage> {
  const limit = pagination.limit ?? 20;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (pagination.cursor !== undefined &&
      (typeof pagination.cursor !== 'string' ||
        !pagination.cursor.length ||
        pagination.cursor.length > 1024))
  ) {
    throw catalogueError(source, 'Invalid catalogue pagination', 'INVALID_PAGINATION');
  }
  const native = search ? source.searchMangaPage : source.fetchMangaPage;
  if (typeof native === 'function') return native.call(source, value, pagination, filters);
  const cursor = pagination.cursor ?? 'legacy:0';
  if (!/^legacy:(0|[1-9]\d*)$/.test(cursor)) {
    throw catalogueError(source, 'Invalid legacy catalogue cursor', 'INVALID_CURSOR');
  }
  const offset = Number(cursor.slice('legacy:'.length));
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + limit)) {
    throw catalogueError(source, 'Invalid legacy catalogue offset', 'INVALID_CURSOR');
  }
  const method = search ? source.searchManga : source.fetchManga;
  const rows = await method.call(source, value, { limit: limit + 1, offset }, filters);
  if (!Array.isArray(rows)) {
    throw catalogueError(source, 'Source returned an invalid catalogue');
  }
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { items, hasMore, ...(hasMore ? { nextCursor: `legacy:${offset + items.length}` } : {}) };
}

const bundlePath = process.argv[2];

function send(message: ChildMessage): void {
  // Undefined only without an IPC channel, which the parent always requests.
  process.send?.(message);
}

let nextFetchId = 0;
const pendingFetches = new Map<
  number,
  { resolve: (r: FetchProxyResponse) => void; reject: (error: Error) => void }
>();

/** Replaces the global `fetch` with a proxy to the parent, before anything the bundle
 * does gets a chance to run. The bundle sees an ordinary-looking `fetch()` — it has no
 * way to tell its requests aren't going out directly. */
function installFetchShim(): void {
  const proxiedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (initHeaders) {
      new Headers(initHeaders).forEach((value, key) => {
        headers[key] = value;
      });
    }
    const body = typeof init?.body === 'string' ? init.body : null;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');

    const id = nextFetchId++;
    let resolveResponse: (response: FetchProxyResponse) => void = () => undefined;
    let rejectResponse: (error: Error) => void = () => undefined;
    const trackedResponse = new Promise<FetchProxyResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    pendingFetches.set(id, { resolve: resolveResponse, reject: rejectResponse });
    const onAbort = () => {
      pendingFetches.delete(id);
      send({ kind: 'fetch-abort', id });
      rejectResponse(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    send({ kind: 'fetch', id, url, method, headers, body });

    let response: FetchProxyResponse;
    try {
      response = await trackedResponse;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      pendingFetches.delete(id);
    }
    if (!response.ok) {
      throw new TypeError(response.error);
    }
    const bodyBytes = Buffer.from(response.bodyBase64, 'base64');
    return new Response(bodyBytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  globalThis.fetch = proxiedFetch as typeof fetch;
}

function pathToFileUrl(filePath: string): string {
  return new URL(`file://${filePath.replace(/\\/g, '/')}`).href;
}

let sourcePromise: Promise<Source> | null = null;

/** Loaded once, lazily, on the first real request — a bundle that only ever gets asked
 * for metadata would otherwise pay an unnecessary import cost. */
function getSource(): Promise<Source> {
  if (!sourcePromise) {
    sourcePromise = (async () => {
      if (!bundlePath) {
        throw new Error('Sandbox runner started with no bundle path');
      }
      const mod = (await import(pathToFileUrl(bundlePath))) as { default?: unknown };
      const candidate = mod.default;
      if (!candidate || typeof (candidate as Partial<Source>).fetchManga !== 'function') {
        throw new Error('Bundle does not default-export a valid Source implementation');
      }
      return candidate as Source;
    })();
  }
  return sourcePromise;
}

const SOURCE_ERROR_CODES: ReadonlySet<string> = new Set<SourceErrorCode>([
  'NETWORK_ERROR',
  'TIMEOUT',
  'NOT_FOUND',
  'BLOCKED',
  'RATE_LIMITED',
  'PARSE_ERROR',
  'UPSTREAM_ERROR',
]);

/** Every string crossing this boundary comes from extension code, and the parent puts
 * some of it in log lines and API responses. A bundle throwing a megabyte-long `detail`
 * shouldn't get to fill the server's logs with it. */
const MAX_FIELD_LENGTH = 4000;

function clamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : undefined;
}

/**
 * Flattens whatever the source threw into plain JSON, preserving a `SourceError`'s
 * classification so the parent can rebuild it.
 *
 * Matched structurally rather than with `instanceof`: the bundle carries its own copy of
 * whatever error class it uses (it is a self-contained bundle — a third-party source may
 * not use this package's `SourceError` at all), so class identity never lines up across
 * the boundary. `code` is only accepted when it is one of the known `SourceErrorCode`
 * values, because the parent maps it straight onto an HTTP status.
 */
function serializeError(error: unknown): SerializedSourceError {
  const message = error instanceof Error ? error.message : String(error);
  const payload: SerializedSourceError = { message: message.slice(0, MAX_FIELD_LENGTH) };

  if (typeof error !== 'object' || error === null) {
    return payload;
  }

  const candidate = error as {
    code?: unknown;
    sourceId?: unknown;
    statusCode?: unknown;
    reason?: unknown;
    detail?: unknown;
    url?: unknown;
  };

  if (typeof candidate.code !== 'string' || !SOURCE_ERROR_CODES.has(candidate.code)) {
    return payload;
  }

  payload.code = candidate.code as SourceErrorCode;
  payload.sourceId = clamp(candidate.sourceId);
  payload.reason = clamp(candidate.reason);
  payload.detail = clamp(candidate.detail);
  payload.url = clamp(candidate.url);
  if (typeof candidate.statusCode === 'number' && Number.isFinite(candidate.statusCode)) {
    payload.statusCode = candidate.statusCode;
  }

  return payload;
}

const ALLOWED_METHODS: ReadonlySet<SourceCallRequest['method']> = new Set([
  'getCapabilities',
  'fetchMangaPage',
  'searchMangaPage',
  'resolveMangaUrl',
  'fetchManga',
  'searchManga',
  'fetchMangaDetails',
  'fetchMangaThumbnail',
  'fetchChapters',
  'fetchChapterPages',
  'getFilters',
  'fetchMangaUpdates',
]);

async function handleSourceCall(request: SourceCallRequest): Promise<void> {
  try {
    if (!ALLOWED_METHODS.has(request.method)) {
      throw new Error(`Unknown or disallowed Source method: ${request.method}`);
    }
    const source = await getSource();
    if (request.method === 'getCapabilities') {
      send({
        kind: 'source-call',
        id: request.id,
        ok: true,
        result: await sourceCapabilities(source),
      });
      return;
    }
    if (request.method === 'fetchMangaPage' || request.method === 'searchMangaPage') {
      const [value, pagination, filters] = request.args as Parameters<
        NonNullable<Source['fetchMangaPage']>
      >;
      const result = await sourceCataloguePage(
        source,
        request.method === 'searchMangaPage',
        value ?? undefined,
        pagination ?? {},
        filters ?? {},
      );
      send({ kind: 'source-call', id: request.id, ok: true, result });
      return;
    }
    if (request.method === 'resolveMangaUrl' && !(await sourceCapabilities(source)).urlSearch) {
      throw new Error('This source does not support URL search');
    }
    const method = source[request.method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof method !== 'function') {
      throw new Error(`This source does not implement ${request.method}`);
    }
    const result = await method.apply(source, request.args);
    send({ kind: 'source-call', id: request.id, ok: true, result });
  } catch (error) {
    send({
      kind: 'source-call',
      id: request.id,
      ok: false,
      error: serializeError(error),
    });
  }
}

if (process.argv[1] && pathToFileUrl(process.argv[1]) === import.meta.url) {
  installFetchShim();

  process.on('message', (message: ParentMessage) => {
    if (message.kind === 'source-call') {
      void handleSourceCall(message);
      return;
    }
    // Otherwise a fetch response: settle the shim call awaiting it.
    const pending = pendingFetches.get(message.id);
    if (pending) {
      pendingFetches.delete(message.id);
      pending.resolve(message);
    }
  });

  // The parent disconnecting (it crashed, or deliberately tore this source down) means
  // there's no one left to answer — exit rather than becoming an orphaned process.
  process.on('disconnect', () => {
    process.exit(0);
  });

  // Stray bundle errors must not kill the process silently. No request id is available
  // here, so this can only log; per-request errors are caught in handleSourceCall.
  process.on('uncaughtException', (error) => {
    console.error('[sandbox runner] Uncaught exception:', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[sandbox runner] Unhandled rejection:', reason);
  });
}
