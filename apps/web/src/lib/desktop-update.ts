'use client';

/**
 * The desktop app's self-update bridge (apps/desktop/src/main/updater.ts, exposed by its
 * preload as `window.desktop.update`). Absent in a plain browser.
 *
 * The types mirror UpdateState in the desktop app. They are duplicated rather than imported
 * because apps/web must not depend on apps/desktop.
 */
export interface UpdateState {
  supported: boolean;
  status:
    | 'unsupported'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'up-to-date'
    | 'error';
  currentVersion: string;
  availableVersion: string | null;
  downloadPercent: number | null;
  error: string | null;
  autoDownload: boolean;
  /** Plain-text release notes for the version on offer (older desktop builds omit it). */
  releaseNotes?: string | null;
  /** Whether the launch prompt should show for the version on offer. */
  prompt?: boolean;
}

export interface Envelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

export interface UpdateBridge {
  getState: () => Promise<Envelope<UpdateState>>;
  check: () => Promise<Envelope<UpdateState>>;
  download: () => Promise<Envelope<UpdateState>>;
  setAutoDownload: (enabled: boolean) => Promise<Envelope<UpdateState>>;
  installNow: () => Promise<Envelope<null>>;
  /** Present from the desktop build that added the launch prompt. */
  updateNow?: () => Promise<Envelope<UpdateState>>;
  dismiss?: (choice: 'later' | 'skip') => Promise<Envelope<UpdateState>>;
}

export function updateBridge(): UpdateBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { desktop?: { update?: UpdateBridge } }).desktop?.update ?? null;
}
