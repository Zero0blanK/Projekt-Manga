/**
 * IPC contract between the parent process (spawnSandboxedSource.ts) and the sandboxed
 * child (runner.ts). Two independent request/response pairs share the same channel,
 * distinguished by `kind`:
 *
 *  - source-call: parent -> child. Invokes one `Source` method, child replies with the
 *    plain-JSON result or an error message.
 *  - fetch: child -> parent. The child's own network access is fully denied at the
 *    Node process level (see spawnSandboxedSource.ts's doc comment on why `--allow-net`
 *    isn't used for this) — its global `fetch` is instead a shim that asks the parent to
 *    make the real request. The parent checks the URL against this source's allowlist
 *    and the SSRF guard before ever making it, then relays the response back.
 *
 * Nothing richer than plain JSON (base64 for binary bodies) ever crosses this boundary —
 * no live objects, no callbacks — so there's no way for the sandboxed side to smuggle
 * anything but data across it.
 */

import type { SourceErrorCode } from '@projekt-manga/types';

/** The subset of Source methods that make a real network call and are worth running
 * sandboxed — id/name/lang/base_url/isNSFW are plain metadata already known from the
 * installed_extension row and never need a round-trip. */
export type SandboxedMethod =
  | 'getCapabilities'
  | 'fetchMangaPage'
  | 'searchMangaPage'
  | 'resolveMangaUrl'
  | 'fetchManga'
  | 'searchManga'
  | 'fetchMangaDetails'
  | 'fetchMangaThumbnail'
  | 'fetchChapters'
  | 'fetchChapterPages'
  | 'getFilters'
  | 'fetchMangaUpdates';

export interface SourceCallRequest {
  kind: 'source-call';
  id: number;
  method: SandboxedMethod;
  args: unknown[];
}

/**
 * A failed call, flattened to plain JSON.
 *
 * The structured `SourceError` fields (`code`/`reason`/`detail`) are carried across so the
 * server classifies a sandboxed source's failures exactly like a bundled one's (for
 * example a 503 for "source is blocking us" instead of a generic 500).
 *
 * `code` is only ever one of the `SourceErrorCode` values — the child validates it against
 * that set before sending, since it comes from extension code the app doesn't control and
 * ends up selecting an HTTP status.
 */
export interface SerializedSourceError {
  message: string;
  code?: SourceErrorCode;
  sourceId?: string;
  statusCode?: number;
  reason?: string;
  detail?: string;
  url?: string;
}

export type SourceCallResponse =
  | { kind: 'source-call'; id: number; ok: true; result: unknown }
  | { kind: 'source-call'; id: number; ok: false; error: SerializedSourceError };

export interface FetchProxyRequest {
  kind: 'fetch';
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  /** UTF-8 string bodies only; binary request bodies are not supported by the proxy. */
  body: string | null;
}

/** Cancels the parent-owned network request associated with a shimmed fetch. */
export interface FetchProxyAbort {
  kind: 'fetch-abort';
  id: number;
}

export type FetchProxyResponse =
  | {
      kind: 'fetch';
      id: number;
      ok: true;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      bodyBase64: string;
    }
  | { kind: 'fetch'; id: number; ok: false; error: string };

/** Messages the parent sends to the child. */
export type ParentMessage = SourceCallRequest | FetchProxyResponse;
/** Messages the child sends to the parent. */
export type ChildMessage = SourceCallResponse | FetchProxyRequest | FetchProxyAbort;
