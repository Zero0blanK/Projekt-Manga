import type net from 'net';
import { Agent, fetch as undiciFetch } from 'undici';
import { guardedLookup, isDisallowedIpAddress, UnsafeUrlError } from './ssrfGuard.js';

let dispatcher: Agent | undefined;

/** An address the caller already resolved and validated (DNS over HTTPS in the sandbox). */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * A `lookup` that answers with the pinned address instead of asking DNS, and checks it
 * again on the way: the pin came from outside this module, so it is not trusted blindly.
 */
export function pinnedLookup(pin: PinnedAddress): net.LookupFunction {
  return (hostname, options, callback) => {
    if (isDisallowedIpAddress(pin.address)) {
      callback(new UnsafeUrlError(`Refusing to connect to ${hostname} (${pin.address})`), '', 0);
      return;
    }
    if (options.all) {
      callback(null, [{ address: pin.address, family: pin.family }]);
      return;
    }
    callback(null, pin.address, pin.family);
  };
}

const MAX_PINNED_DISPATCHERS = 64;
const pinnedDispatchers = new Map<string, Agent>();

/** One pooled agent per pinned address, bounded so a long-running server can't collect
 * them without limit; the oldest closes gracefully once its requests finish. */
function pinnedDispatcher(pin: PinnedAddress): Agent {
  const key = `${pin.family}/${pin.address}`;
  let agent = pinnedDispatchers.get(key);
  if (!agent) {
    if (pinnedDispatchers.size >= MAX_PINNED_DISPATCHERS) {
      const [oldestKey, oldest] = pinnedDispatchers.entries().next().value!;
      pinnedDispatchers.delete(oldestKey);
      void oldest.close().catch(() => undefined);
    }
    agent = new Agent({ connect: { lookup: pinnedLookup(pin) } });
    pinnedDispatchers.set(key, agent);
  }
  return agent;
}

/** `fetch` whose sockets are checked at connect time: the resolved address must be public.
 * With a `pin`, it connects to that address instead of resolving the hostname, checked
 * the same way.
 * The URL pre-check alone leaves a window in which a hostname can resolve differently
 * (DNS rebinding); validating inside the lookup removes it. Created lazily so importing
 * this module costs nothing for callers that never fetch. */
export function guardedFetch(url: URL, init: RequestInit, pin?: PinnedAddress): Promise<Response> {
  dispatcher ??= new Agent({ connect: { lookup: guardedLookup } });
  return undiciFetch(url, {
    ...init,
    dispatcher: pin ? pinnedDispatcher(pin) : dispatcher,
  } as Parameters<typeof undiciFetch>[1]) as Promise<Response>;
}
