import { Agent, fetch as undiciFetch } from 'undici';
import { guardedLookup } from './ssrfGuard.js';

let dispatcher: Agent | undefined;

/** `fetch` whose sockets are checked at connect time: the resolved address must be public.
 * The URL pre-check alone leaves a window in which a hostname can resolve differently
 * (DNS rebinding); validating inside the lookup removes it. Created lazily so importing
 * this module costs nothing for callers that never fetch. */
export function guardedFetch(url: URL, init: RequestInit): Promise<Response> {
  dispatcher ??= new Agent({ connect: { lookup: guardedLookup } });
  return undiciFetch(url, { ...init, dispatcher } as Parameters<
    typeof undiciFetch
  >[1]) as Promise<Response>;
}
