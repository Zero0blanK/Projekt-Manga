// Local-vs-remote branch for desktop's local-first data layer (apps/desktop's
// main/db/local-store.ts, reached over the `desktop:data:invoke` IPC channel). Lives
// here rather than as a wrapper apps/web has to import separately, so existing call
// sites (getManga(), addHistory(), etc.) don't change at all — this package decides the
// transport, callers just ask for data.
//
// `apps/web` must keep working in a plain browser with zero Electron APIs present: the
// `window.desktop?.data` check below is the same optional-chain-with-SSR-guard pattern
// already used by apps/web/src/components/downloads/open-folder-button.tsx, so a plain
// browser (window.desktop is undefined) always falls through to the existing HTTP path.

interface DataInvokeEnvelope<T> {
  success: boolean;
  message: string;
  data?: T;
}

interface DesktopDataBridge {
  invoke: (domain: string, op: string, args?: unknown) => Promise<DataInvokeEnvelope<unknown>>;
}

function getDesktopDataBridge(): DesktopDataBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as unknown as { desktop?: { data?: DesktopDataBridge } }).desktop?.data;
  return bridge ?? null;
}

/** True when running inside the Electron shell with the local-first data bridge present
 * — false in a plain browser (including apps/web served outside Electron) and false in
 * any non-browser environment (SSR). */
export function hasLocalDataBridge(): boolean {
  return getDesktopDataBridge() !== null;
}

/** Calls the local SQLite DB via IPC. Throws if no desktop bridge is present — callers
 * must check hasLocalDataBridge() first (or catch and fall back to the HTTP path). */
export async function localInvoke<T>(domain: string, op: string, args?: unknown): Promise<T> {
  const bridge = getDesktopDataBridge();
  if (!bridge) {
    throw new Error('Local data bridge is not available in this environment');
  }

  const result = await bridge.invoke(domain, op, args);
  if (!result.success) {
    throw new Error(result.message || 'Local data call failed');
  }
  return result.data as T;
}
