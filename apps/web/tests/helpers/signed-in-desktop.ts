import { vi } from 'vitest';

type Invoke = (domain: string, op: string, args?: unknown) => Promise<unknown>;

/**
 * A desktop data bridge for a signed-in account: it answers the api-client's mode question
 * as local-first (only an account keeps library data locally) and passes every other call
 * to `invoke`, so a test's own assertions on `invoke` still see exactly its calls.
 */
export function signedInBridge(invoke: Invoke) {
  return vi.fn((...call: Parameters<Invoke>) =>
    call[0] === 'meta' && call[1] === 'mode'
      ? Promise.resolve({ success: true, message: '', data: { localFirst: true } })
      : invoke(...call),
  );
}
