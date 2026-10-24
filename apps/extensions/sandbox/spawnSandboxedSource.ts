/**
 * Parent-side half of the sandbox: spawns runner.ts as a locked-down child process per
 * installed extension and wraps it as a plain `Source`, so the rest of the app can call
 * a repo-installed source exactly like a bundled one. See runner.ts for the child side.
 * Network access is proxied through this process rather than granted to the child via
 * `--allow-net`.
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Source,
  Mangas,
  MangaDetails,
  Chapters,
  MangaFilter,
  Page,
  Pagination,
  FilterValue,
  ChapterPagesResult,
  SourceCapabilities,
  SourceCataloguePage,
  SourcePageRequest,
} from '@projekt-manga/types';
import type {
  SourceCallRequest,
  ChildMessage,
  ParentMessage,
  FetchProxyRequest,
  SandboxedMethod,
  SerializedSourceError,
} from './types.js';
import { SourceError } from '../sourceError.js';
import { waitForMangaDexDispatch } from './mangadexPacing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Always the compiled output: fork needs a real .js entry point, so apps/extensions must be
// built for the sandbox to work.
const RUNNER_PATH = path.join(__dirname, 'runner.js');

/** How long a child gets to exit on SIGTERM before it is killed outright. */
const SIGKILL_GRACE_MS = 2000;

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Ceiling on a single proxied response, buffered in *this* process.
 *
 * The child's `--max-old-space-size` only caps the child; the fetch proxy runs here in the
 * trusted parent, so an uncapped read (plus ~33% base64 overhead for IPC) would let a
 * source pointed at a huge file, or a compromised allowlisted host, exhaust the API
 * process's memory. Generous enough for any page image a source legitimately fetches.
 */
const MAX_PROXIED_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Reads a response body, refusing to buffer more than `maxBytes`.
 *
 * Checks the declared length first as a cheap rejection, then counts actual bytes, because
 * `content-length` is upstream-supplied and may be absent or a lie — the streaming count is
 * what actually holds. Cancels the body on breach so the rest is never downloaded.
 */
async function readBodyWithCap(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response declares ${declared} bytes, over the ${maxBytes}-byte proxy limit`);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Response exceeded the ${maxBytes}-byte proxy limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}

/** V8 heap soft-limit for the child. It catches runaway JS allocation but is not a hard
 * memory cap: native memory exhaustion would need an OS-level mechanism (cgroup, job object). */
const DEFAULT_MAX_OLD_SPACE_MB = 256;

export interface SandboxedSourceMetadata {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;
}

export interface SandboxedSourceOptions {
  /** Absolute path to the downloaded, hash-verified bundle for this installed
   * extension. The child's filesystem read allowlist is scoped to this file's own
   * directory and nothing else. */
  bundlePath: string;
  /** Hostnames this source is allowed to reach, checked against every outbound fetch
   * the sandboxed code makes: an exact match or a subdomain of one of these. An empty
   * list means no outbound request is ever forwarded. */
  allowedNetHosts: string[];
  timeoutMs?: number;
  /** Extra validation beyond the hostname allowlist, run against every proxied
   * request's full URL before it's made, e.g. the server's SSRF guard so an allowlisted
   * hostname resolving to a private IP is still blocked. Supplied by the caller because
   * this package cannot import server code. Return/resolve false, or throw, to deny. */
  validateOutboundUrl?: (url: URL) => Promise<boolean> | boolean;
  /** Replaces the global `fetch` for proxied requests, so the caller can pin the connection
   * to a validated address (the URL check alone leaves a DNS-rebinding window). */
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

/**
 * Rebuilds the error the sandboxed source threw, so a repo-installed source is classified
 * exactly like a bundled one (the server matches structurally on `code`/`reason`/`detail`).
 *
 * A payload with no `code` stays a plain Error on purpose: the source threw something
 * unclassified, and inventing a category would be worse than a generic failure.
 */
function reviveCallError(payload: SerializedSourceError, fallbackSourceId: string): Error {
  if (!payload.code) {
    return new Error(payload.message);
  }

  return new SourceError(payload.code, payload.message, payload.sourceId ?? fallbackSourceId, {
    statusCode: payload.statusCode,
    reason: payload.reason,
    detail: payload.detail,
    url: payload.url,
  });
}

/**
 * `--allow-net` — the flag that makes network a permission the Node process model gates
 * at all — only exists since Node 25.0.0. On earlier versions with `--permission`, network
 * is not a gated resource: omitting `--allow-net` (as `ensureChild()` does, relying on the
 * fetch proxy) restricts nothing, and the child would have unrestricted network access,
 * silently defeating the sandbox. Checked at first use so an unsupported Node fails
 * loudly instead.
 */
function assertNodeSupportsNetworkPermission(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 25) {
    throw new Error(
      `Sandboxed extension execution requires Node >= 25.0.0 (running ${process.versions.node}) — ` +
        `earlier versions don't gate network access under --permission at all, so a sandboxed source ` +
        `would get real, unrestricted network access instead of the isolation this subsystem promises.`,
    );
  }
}

/** One sandboxed child process per installed source, started lazily and reused across
 * calls. Call `dispose()` when the source is uninstalled or the app is shutting down. */
export function spawnSandboxedSource(
  metadata: SandboxedSourceMetadata,
  options: SandboxedSourceOptions,
): Source & { dispose(): void } {
  let child: ChildProcess | null = null;
  let nextRequestId = 0;
  const pending = new Map<number, PendingCall>();
  /** Proxied fetches still in flight, so `killChild` can cancel them. */
  const inflightFetches = new Map<number, AbortController>();

  /**
   * Sends a message to the child, tolerating a channel that has already closed.
   *
   * `subprocess.send()` on a closed channel reports ERR_IPC_CHANNEL_CLOSED, and with no
   * callback it does so by emitting `'error'` on the ChildProcess, which unhandled is an
   * uncaught exception that takes down the API process. This is reachable without hostile
   * intent: a call that outruns its timeout kills the child, and the proxied fetch it was
   * waiting on then replies to a dead child. The callback routes the failure there instead
   * of to `'error'`; the `connected` check skips the attempt in the common case.
   */
  function sendToChild(proc: ChildProcess, message: ParentMessage | SourceCallRequest): boolean {
    if (!proc.connected) {
      return false;
    }
    return proc.send(message, (error) => {
      if (error) {
        console.warn(`[sandbox] Dropped a message to source "${metadata.id}": ${error.message}`);
      }
    });
  }

  /**
   * Terminates the child and clears the handle so the next call spawns a fresh one.
   *
   * SIGTERM first, then SIGKILL after a grace period: a source wedged in a tight loop can
   * be too busy to run its own signal handler, and plain `kill()` would leave it running
   * forever. The escalation timer is unref'd so it can never hold the process open.
   */
  function killChild(reason: string): void {
    const dying = child;
    child = null;

    // Nothing is left to receive these replies, so stop downloading them.
    for (const controller of inflightFetches.values()) {
      controller.abort();
    }
    inflightFetches.clear();

    if (!dying || dying.killed) {
      return;
    }

    dying.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (!dying.killed) {
        console.warn(
          `[sandbox] Source "${metadata.id}" ignored SIGTERM after ${reason}; sending SIGKILL`,
        );
        dying.kill('SIGKILL');
      }
    }, SIGKILL_GRACE_MS);
    escalation.unref?.();
  }

  function rejectAllPending(reason: string): void {
    for (const [id, call] of pending) {
      call.reject(new Error(reason));
      pending.delete(id);
    }
  }

  async function validateOutboundHop(url: URL): Promise<void> {
    if (!isHostAllowed(url.hostname, options.allowedNetHosts)) {
      throw new Error(`Host "${url.hostname}" is not in this source's allowlist`);
    }
    if (options.validateOutboundUrl) {
      const allowed = await options.validateOutboundUrl(url);
      if (!allowed) {
        throw new Error(`Blocked by outbound URL validation: ${url.href}`);
      }
    }
  }

  const MAX_REDIRECTS = 5;

  async function handleFetchProxyRequest(
    request: FetchProxyRequest,
    proc: ChildProcess,
  ): Promise<void> {
    const controller = new AbortController();
    inflightFetches.set(request.id, controller);
    try {
      let url = new URL(request.url);
      let method = request.method;
      let body = request.body ?? undefined;
      let response: Response;

      // Redirects are followed manually: `redirect: "follow"` would let an allowlisted host
      // redirect to a private or internal address (e.g. a cloud metadata endpoint),
      // bypassing the allowlist and SSRF guard. Every hop is re-validated like the original URL.
      for (let hops = 0; ; hops++) {
        await validateOutboundHop(url);
        await waitForMangaDexDispatch(url, method, controller.signal);
        controller.signal.throwIfAborted();
        response = await (options.fetchImpl ?? fetch)(url, {
          method,
          headers: request.headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        });

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get('location');
        if (!isRedirect || !location) {
          break;
        }
        if (hops >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects fetching ${request.url}`);
        }
        url = new URL(location, url);
        // 303, and 301/302 on non-GET/HEAD, downgrade to a bodyless GET (browser behavior);
        // 307/308 preserve the method and body.
        if (
          response.status === 303 ||
          (method !== 'GET' &&
            method !== 'HEAD' &&
            response.status !== 307 &&
            response.status !== 308)
        ) {
          method = 'GET';
          body = undefined;
        }
      }

      const bodyBuffer = await readBodyWithCap(response, MAX_PROXIED_RESPONSE_BYTES);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const reply: ParentMessage = {
        kind: 'fetch',
        id: request.id,
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers,
        bodyBase64: bodyBuffer.toString('base64'),
      };
      sendToChild(proc, reply);
    } catch (error) {
      const reply: ParentMessage = {
        kind: 'fetch',
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      sendToChild(proc, reply);
    } finally {
      if (inflightFetches.get(request.id) === controller) inflightFetches.delete(request.id);
    }
  }

  function ensureChild(): ChildProcess {
    if (child) {
      return child;
    }

    assertNodeSupportsNetworkPermission();

    const bundleDir = path.dirname(options.bundlePath);
    const execArgv = [
      '--permission',
      `--allow-fs-read=${bundleDir}/*`,
      `--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_MB}`,
      // Deliberately no --allow-net: outbound requests go through the fetch shim
      // (runner.ts) to this process, which enforces the host allowlist and
      // validateOutboundUrl before making the real request.
    ];

    const proc = fork(RUNNER_PATH, [options.bundlePath], {
      execArgv,
      // Empty environment so the child never sees DATABASE_URL, session secrets, or
      // anything else from this process's env.
      env: {},
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      console.log(`[sandbox:${metadata.id}]`, chunk.toString().trimEnd());
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[sandbox:${metadata.id}]`, chunk.toString().trimEnd());
    });

    proc.on('message', (message: ChildMessage) => {
      if (message.kind === 'fetch-abort') {
        inflightFetches.get(message.id)?.abort();
        return;
      }
      if (message.kind === 'fetch') {
        void handleFetchProxyRequest(message, proc);
        return;
      }
      const call = pending.get(message.id);
      if (!call) {
        return;
      }
      pending.delete(message.id);
      if (message.ok) {
        call.resolve(message.result);
      } else {
        call.reject(reviveCallError(message.error, metadata.id));
      }
    });

    // Required: an unhandled 'error' on a ChildProcess is an uncaught exception. It fires
    // when the process cannot be spawned (e.g. runner.js missing because the package was
    // not rebuilt) or an IPC send fails without a callback. Lose this source, not the server.
    proc.on('error', (error) => {
      console.error(`[sandbox] Source "${metadata.id}" process error: ${error.message}`);
      rejectAllPending(`Sandboxed source "${metadata.id}" failed: ${error.message}`);
      if (child === proc) {
        child = null;
      }
    });

    proc.on('exit', (code) => {
      rejectAllPending(
        `Sandboxed source "${metadata.id}" exited unexpectedly (code ${code}) before responding`,
      );
      if (child === proc) {
        child = null;
      }
    });

    child = proc;
    return proc;
  }

  function call(method: SandboxedMethod, args: unknown[]): Promise<unknown> {
    const proc = ensureChild();
    const id = nextRequestId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Kill the child rather than abandon the call: a wedged process would otherwise be
        // reused by every later call. The next call spawns a clean one.
        killChild(`timed out after ${timeoutMs}ms`);
        // Classified as TIMEOUT (matching a source's own timeout) so callers can respond
        // with "try again". `message` is user-facing; internals stay in `detail`.
        reject(
          new SourceError(
            'TIMEOUT',
            `${metadata.name} took too long to respond. Try again.`,
            metadata.id,
            {
              reason: `Timed out after ${timeoutMs}ms`,
              detail: `Sandboxed source "${metadata.id}" call "${method}" timed out after ${timeoutMs}ms`,
            },
          ),
        );
      }, timeoutMs);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      const request: SourceCallRequest = { kind: 'source-call', id, method, args };
      if (!sendToChild(proc, request)) {
        // The child died between ensureChild() and here; fail now instead of waiting out the timeout.
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`Sandboxed source "${metadata.id}" is not running`));
      }
    });
  }

  return {
    id: metadata.id,
    name: metadata.name,
    lang: metadata.lang,
    base_url: metadata.base_url,
    isNSFW: metadata.isNSFW,

    getCapabilities: () => call('getCapabilities', []) as Promise<SourceCapabilities>,
    fetchMangaPage: (
      category?: string,
      pagination?: SourcePageRequest,
      filters?: Record<string, FilterValue>,
    ) => call('fetchMangaPage', [category, pagination, filters]) as Promise<SourceCataloguePage>,
    searchMangaPage: (
      query?: string,
      pagination?: SourcePageRequest,
      filters?: Record<string, FilterValue>,
    ) => call('searchMangaPage', [query, pagination, filters]) as Promise<SourceCataloguePage>,
    resolveMangaUrl: (url: string) => call('resolveMangaUrl', [url]) as Promise<Mangas | null>,

    fetchManga: (
      category?: string,
      pagination?: Pagination,
      filters?: Record<string, FilterValue>,
    ) => call('fetchManga', [category, pagination, filters]) as Promise<Mangas[]>,

    searchManga: (query?: string, pagination?: Pagination, filters?: Record<string, FilterValue>) =>
      call('searchManga', [query, pagination, filters]) as Promise<Mangas[]>,

    fetchMangaDetails: (manga_id: string) =>
      call('fetchMangaDetails', [manga_id]) as Promise<MangaDetails>,

    fetchMangaThumbnail: (manga_id: string) =>
      call('fetchMangaThumbnail', [manga_id]) as Promise<string>,

    fetchChapters: (manga_id: string) => call('fetchChapters', [manga_id]) as Promise<Chapters[]>,

    fetchChapterPages: (chapter_id: string, manga_slug?: string, pagination?: Pagination) =>
      call('fetchChapterPages', [chapter_id, manga_slug, pagination]) as Promise<
        ChapterPagesResult<Page>
      >,

    getFilters: () => call('getFilters', []) as Promise<MangaFilter[]>,

    fetchMangaUpdates: (manga_slug: string) =>
      call('fetchMangaUpdates', [manga_slug]) as Promise<Chapters[]>,

    dispose() {
      rejectAllPending(`Sandboxed source "${metadata.id}" was disposed`);
      killChild('disposed');
    },
  };
}
