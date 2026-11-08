'use client';

import { desktopBridge } from '@/lib/desktop-bridge';
import type { Change } from '@/lib/changelog';

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
  /** Plain-text release notes for the version on offer (older desktop builds omit it). */
  releaseNotes?: string | null;
  /** The version on offer's changelog.json entry, fetched from its release tag (older desktop
   * builds omit it). */
  changelog?: {
    version: string;
    date: string;
    summary: string | null;
    upgrade: string | null;
    changes: Change[];
  } | null;
  /** True while the desktop app is still fetching `changelog`. */
  changelogPending?: boolean;
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
  installNow: () => Promise<Envelope<null>>;
  /** Present from the desktop build that added the launch prompt. */
  updateNow?: () => Promise<Envelope<UpdateState>>;
  dismiss?: (choice: 'later' | 'skip') => Promise<Envelope<UpdateState>>;
}

export function updateBridge(): UpdateBridge | null {
  if (typeof window === 'undefined') return null;
  return desktopBridge<{ update: UpdateBridge }>()?.update ?? null;
}
