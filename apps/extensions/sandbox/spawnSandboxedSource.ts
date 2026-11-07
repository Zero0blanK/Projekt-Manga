/**
 * Parent-side half of the sandbox: spawns runner.ts as a locked-down child process per
 * installed extension and wraps it as a plain `Source`, so the rest of the app can call
 * a repo-installed source exactly like a bundled one. See runner.ts for the child side.
 * Network access is proxied through this process rather than granted to the child via
 * `--allow-net`.
 */
import { fork, type ChildProcess } from 'node:child_process';
import net from 'node:net';
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
  UrlKeysRequest,
  UrlKeysResult,
} from './types.js';
import { SourceError } from '../sourceError.js';
import { waitForMangaDexDispatch } from './mangadexPacing.js';
import { isCloudflareChallenge, type SandboxBrowserSession } from './cookieJar.js';
import { resolveWithDoh, type ResolvedAddress } from './doh.js';
import { residentBytes } from './childMemory.js';

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
  fetchImpl?: (url: URL, init: RequestInit, pin?: PinnedAddress) => Promise<Response>;
  /** Cookies and User-Agent from a real browser session (see cookieJar.ts), added to
   * requests here in the parent so the child never sees them. Without one, requests go
   * out with only the headers the source set. Either way `Set-Cookie` never reaches the
   * child. */
  browserSession?: SandboxBrowserSession;
  /** Custom User-Agent and DNS over HTTPS; see `SandboxNetworkSettings`. */
  networkSettings?: () => SandboxNetworkSettings | null | undefined;
}

/**
 * Operator-level network settings for proxied requests, read on every request so a change
 * takes effect without respawning the source. Neither changes which hosts are allowed.
 */
export interface SandboxNetworkSettings {
  /** Replaces the User-Agent a source sets. A browser session's own User-Agent still wins
   * for its hosts, because its clearance cookie is tied to it. */
  userAgent?: string | null;
  /** A DNS over HTTPS resolver (JSON API) used instead of system DNS. Every address it
   * returns goes through `validateOutboundUrl` as an IP literal, and the connection is
   * pinned to one of them through `fetchImpl`'s third argument; without both options set,
   * requests are refused rather than resolved some other way. */
  dohUrl?: string | null;
}

/** The address a hop must connect to, already validated. Passed to `fetchImpl`, which
 * must connect there (and may check it again) instead of resolving the hostname itself. */
export type PinnedAddress = ResolvedAddress;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

/** A User-Agent safe to send: printable ASCII only, so it can never inject a header. */
const SAFE_USER_AGENT = /^[\x20-\x7e]{1,512}$/;

/** `URL.hostname` keeps the brackets around an IPv6 literal. */
function isIpLiteral(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return net.isIP(bare) !== 0;
}

/** Response headers the child never receives: cookies belong to the parent's jar. */
const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

/** How much of a response body is inspected for a challenge page's markers. */
const CHALLENGE_SNIFF_BYTES = 16 * 1024;

/**
 * The request headers for one hop: the source's own, the operator's User-Agent if one is
 * set, plus the browser session's cookie and User-Agent for an allowlisted host. The session's User-Agent replaces the source's,
 * because Cloudflare ties its clearance cookie to the browser that earned it.
 */
async function buildHopHeaders(
  url: URL,
  sourceHeaders: Record<string, string>,
  allowedHosts: readonly string[],
  session: SandboxBrowserSession | undefined,
  customUserAgent?: string | null,
): Promise<Headers> {
  const headers = new Headers(sourceHeaders);
  if (customUserAgent && SAFE_USER_AGENT.test(customUserAgent)) {
    headers.set('user-agent', customUserAgent);
  }
  if (!session || !isHostAllowed(url.hostname, allowedHosts)) {
    return headers;
  }
  const extra = await session.headersFor(url);
  if (extra?.cookie) {
    const own = headers.get('cookie');
    headers.set('cookie', own ? `${own}; ${extra.cookie}` : extra.cookie);
  }
  if (extra?.userAgent) {
    headers.set('user-agent', extra.userAgent);
  }
  return headers;
}

function setCookiesOf(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Whether a message from the child has a shape this process can act on.
 *
 * The bundle shares a realm with the runner, so it can call `process.send` itself with
 * anything at all. A `null` or a reply with no `error` would throw inside an event handler
 * here, and an uncaught exception in this process takes the whole API down.
 */
function isChildMessage(message: unknown): message is ChildMessage {
  if (!isRecord(message) || typeof message.id !== 'number') return false;
  if (message.kind === 'fetch-abort') return true;
  if (message.kind === 'fetch') {
    return (
      typeof message.url === 'string' &&
      typeof message.method === 'string' &&
      isRecord(message.headers)
    );
  }
  if (message.kind !== 'source-call') return false;
  return (
    message.ok === true ||
    (message.ok === false && isRecord(message.error) && typeof message.error.message === 'string')
  );
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

/** Well past `DEFAULT_MAX_OLD_SPACE_MB`, which only covers the JavaScript heap, leaving room
 * for page buffers. */
const MAX_CHILD_RESIDENT_BYTES = 1024 * 1024 * 1024;
const MEMORY_CHECK_INTERVAL_MS = 15_000;

/** A source's stdout and stderr, kept from flooding the server's log: a line is cut short,
 * and a noisy source goes quiet until the minute is up. */
const OUTPUT_LINE_CHARS = 2000;
const OUTPUT_LINES_PER_MINUTE = 120;

function limitedOutput(sourceId: string) {
  let windowStart = 0;
  let lines = 0;
  return (write: (...data: unknown[]) => void, chunk: Buffer) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      lines = 0;
    }
    lines += 1;
    if (lines > OUTPUT_LINES_PER_MINUTE) {
      if (lines === OUTPUT_LINES_PER_MINUTE + 1) {
        console.warn(`[sandbox:${sourceId}] Output suppressed for the rest of this minute`);
      }
      return;
    }
    write(`[sandbox:${sourceId}]`, chunk.toString().trimEnd().slice(0, OUTPUT_LINE_CHARS));
  };
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

/** A source running in its sandbox. `keyFromUrl` is synchronous in the contract, so across
 * the process boundary it is offered batched as `keysFromUrls` instead. */
export type SandboxedSource = Source & {
  dispose(): void;
  keysFromUrls(request: UrlKeysRequest): Promise<UrlKeysResult>;
};

/** One sandboxed child process per installed source, started lazily and reused across
 * calls. Call `dispose()` when the source is uninstalled or the app is shutting down. */
export function spawnSandboxedSource(
  metadata: SandboxedSourceMetadata,
  options: SandboxedSourceOptions,
): SandboxedSource {
  let child: ChildProcess | null = null;
  let nextRequestId = 0;
  const pending = new Map<number, PendingCall>();
  /** Proxied fetches still in flight, so `killChild` can cancel them. */
  const inflightFetches = new Map<number, AbortController>();
  /** Calls whose own fetches came back as a Cloudflare challenge, with the page's URL. A
   * call that then fails is reported as CHALLENGE_REQUIRED, whatever the source made of
   * the page; another call failing at the same time keeps its own error. */
  const challengedCalls = new Map<number, string>();
  /** A challenge on a fetch that named no call (an older runner): any call that fails
   * after it is reclassified, as before. */
  let lastUnattributedChallengeAt = 0;
  let lastUnattributedChallengeUrl: string | undefined;

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

  /**
   * Checks one hop and returns the address to pin it to when DNS over HTTPS is on.
   *
   * The allowlist is always checked on the hostname first. With DoH, every address the
   * resolver returns then goes through `validateOutboundUrl` as an IP literal, the same
   * public-address check a literal URL gets, and one bad address refuses the hop, as it
   * does for system DNS.
   */
  async function validateOutboundHop(
    url: URL,
    dohUrl: string | null | undefined,
    signal: AbortSignal,
  ): Promise<PinnedAddress | undefined> {
    if (!isHostAllowed(url.hostname, options.allowedNetHosts)) {
      throw new Error(`Host "${url.hostname}" is not in this source's allowlist`);
    }
    if (dohUrl && !isIpLiteral(url.hostname)) {
      const { validateOutboundUrl, fetchImpl } = options;
      if (!validateOutboundUrl || !fetchImpl) {
        throw new Error('DNS over HTTPS needs outbound URL validation and a pinning fetch');
      }
      const addresses = await resolveWithDoh(
        url.hostname,
        dohUrl,
        fetchImpl,
        readBodyWithCap,
        signal,
      );
      for (const { address, family } of addresses) {
        const literal = new URL(url);
        literal.hostname = family === 6 ? `[${address}]` : address;
        if (!(await validateOutboundUrl(literal))) {
          throw new Error(`Blocked by outbound URL validation: ${url.href}`);
        }
      }
      return addresses[0];
    }
    if (options.validateOutboundUrl) {
      const allowed = await options.validateOutboundUrl(url);
      if (!allowed) {
        throw new Error(`Blocked by outbound URL validation: ${url.href}`);
      }
    }
    return undefined;
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
      // Read once per request so every hop of it uses the same settings.
      const network = options.networkSettings?.() ?? {};

      // Redirects are followed manually: `redirect: "follow"` would let an allowlisted host
      // redirect to a private or internal address (e.g. a cloud metadata endpoint),
      // bypassing the allowlist and SSRF guard. Every hop is re-validated like the original URL.
      for (let hops = 0; ; hops++) {
        const pin = await validateOutboundHop(url, network.dohUrl, controller.signal);
        await waitForMangaDexDispatch(url, method, controller.signal);
        controller.signal.throwIfAborted();
        const headers = await buildHopHeaders(
          url,
          request.headers,
          options.allowedNetHosts,
          options.browserSession,
          network.userAgent,
        );
        const init: RequestInit = {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        };
        response = await (pin
          ? options.fetchImpl!(url, init, pin)
          : (options.fetchImpl ?? fetch)(url, init));

        const setCookies = setCookiesOf(response);
        if (setCookies.length > 0 && options.browserSession) {
          await options.browserSession.receiveSetCookies(url, setCookies);
        }

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
      if (
        isCloudflareChallenge(
          response.status,
          response.headers,
          bodyBuffer.subarray(0, CHALLENGE_SNIFF_BYTES).toString('latin1'),
        )
      ) {
        const page = `${url.origin}${url.pathname}`;
        if (request.callId !== undefined && pending.has(request.callId)) {
          challengedCalls.set(request.callId, page);
        } else if (request.callId === undefined) {
          lastUnattributedChallengeAt = Date.now();
          lastUnattributedChallengeUrl = page;
        }
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) return;
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

    const forward = limitedOutput(metadata.id);
    proc.stdout?.on('data', (chunk: Buffer) => forward(console.log, chunk));
    proc.stderr?.on('data', (chunk: Buffer) => forward(console.error, chunk));

    proc.on('message', (message: unknown) => {
      if (!isChildMessage(message)) {
        console.warn(`[sandbox] Source "${metadata.id}" sent a malformed message`);
        return;
      }
      if (message.kind === 'fetch-abort') {
        inflightFetches.get(message.id)?.abort();
        return;
      }
      if (message.kind === 'fetch') {
        handleFetchProxyRequest(message, proc).catch(() => {
          console.warn(`[sandbox] Source "${metadata.id}" fetch could not be handled`);
        });
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

    // Measured from outside, since nothing inside the child can be trusted to report it.
    const memoryWatch = setInterval(() => {
      if (proc.pid === undefined) return;
      void residentBytes(proc.pid).then((bytes) => {
        if (bytes === null || bytes <= MAX_CHILD_RESIDENT_BYTES || child !== proc) return;
        console.error(`[sandbox] Source "${metadata.id}" used too much memory; stopping it`);
        rejectAllPending(`Sandboxed source "${metadata.id}" used too much memory`);
        killChild('exceeding its memory limit');
      });
    }, MEMORY_CHECK_INTERVAL_MS);
    memoryWatch.unref?.();
    proc.once('exit', () => clearInterval(memoryWatch));

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

  /**
   * Reclassifies a failed call that ran into a Cloudflare challenge. The source may have
   * reported it as BLOCKED, a parse error, or an unclassified throw; what the user needs
   * is to pass the challenge in a browser, so the code says so.
   */
  function withChallenge(error: Error, id: number, startedAt: number): Error {
    const challengedUrl =
      challengedCalls.get(id) ??
      (lastUnattributedChallengeAt >= startedAt ? lastUnattributedChallengeUrl : undefined);
    challengedCalls.delete(id);
    if (!challengedUrl) {
      return error;
    }
    if (error instanceof SourceError && error.code === 'TIMEOUT') {
      return error;
    }
    return new SourceError(
      'CHALLENGE_REQUIRED',
      `${metadata.name} is asking for a browser check (Cloudflare). Open the source in a browser to pass it, then try again.`,
      metadata.id,
      {
        statusCode: error instanceof SourceError ? error.statusCode : undefined,
        reason: 'Cloudflare challenge',
        detail: error.message,
        url: challengedUrl,
      },
    );
  }

  function call(method: SandboxedMethod, args: unknown[]): Promise<unknown> {
    const proc = ensureChild();
    const id = nextRequestId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        challengedCalls.delete(id);
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
          challengedCalls.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(withChallenge(error, id, startedAt));
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

    keysFromUrls: (request: UrlKeysRequest) =>
      call('keysFromUrls', [request]) as Promise<UrlKeysResult>,

    dispose() {
      rejectAllPending(`Sandboxed source "${metadata.id}" was disposed`);
      killChild('disposed');
    },
  };
}
