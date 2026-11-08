/**
 * How far along this launch's local-database seed is, so the renderer can wait for it.
 *
 * The seed (index.ts's `seedWhenServerIsUp`) is started deliberately unawaited, in parallel
 * with the window, so a slow or unreachable API cannot stop the app opening. The cost of
 * that is a race nothing was arbitrating: the renderer reads the library straight out of
 * local.db, which answers in milliseconds *whether or not the seed has written anything
 * yet*. On a launch where the local database was empty, the boot splash therefore saw a
 * resolved-and-empty library, decided the app was ready, and lifted onto a blank library
 * that filled in seconds later.
 *
 * Exposed over IPC rather than pushed: the renderer polls this while the splash is up (see
 * DESKTOP_CHANNELS.initGetState), matching how the updater's state is read and keeping the
 * sandboxed preload free of event listeners.
 */

export type SeedStatus = 'idle' | 'running' | 'done' | 'failed';

/**
 * Whether the bundled API is up yet.
 *
 * The window opens as soon as the web server answers, and the API can take far longer: the
 * first start after an update reads thousands of freshly installed files, each scanned by
 * antivirus on first open. Until it is listening every request fails, so the renderer holds
 * the app on a "starting" screen rather than opening onto errors. `unmanaged` is a run that
 * did not start the servers itself (development, or a missing bundle): nothing to wait for.
 */
export type ApiStatus = 'unmanaged' | 'starting' | 'ready' | 'failed';

export interface DesktopInitState {
  seedStatus: SeedStatus;
  /**
   * Whether local.db already held titles when this launch began.
   *
   * Waiting for the seed
   * unconditionally would hold the splash on every launch for a library that is already
   * on disk and ready to render — the seed re-fetches every title's details, so on a large
   * library that is a long wait for data the reader can already see. There is only
   * something worth waiting for when the database starts out empty.
   */
  hadLocalData: boolean;
  /** Titles written by this run's seed, once it has finished. */
  seededManga: number;
  apiStatus: ApiStatus;
  /** When this run started the API (epoch ms), so the renderer can say how long it has been. */
  apiStartedAt: number | null;
}

let state: DesktopInitState = {
  seedStatus: 'idle',
  hadLocalData: false,
  seededManga: 0,
  apiStatus: 'unmanaged',
  apiStartedAt: null,
};

export function getInitState(): DesktopInitState {
  return state;
}

/** Recorded before the seed starts, from whatever the local database already contains. */
export function markLocalDataPresence(hadLocalData: boolean): void {
  state = { ...state, hadLocalData };
}

export function markSeedStarted(): void {
  state = { ...state, seedStatus: 'running' };
}

export function markSeedFinished(seededManga: number): void {
  state = { ...state, seedStatus: 'done', seededManga };
}

/**
 * A failed seed still resolves the wait.
 *
 * The API being unreachable is an ordinary state — the app is local-first and works from
 * whatever local.db holds — so the splash must let go rather than sit on a seed that is
 * never going to arrive.
 */
export function markSeedFailed(): void {
  state = { ...state, seedStatus: 'failed' };
}

export function markApiStarting(): void {
  state = { ...state, apiStatus: 'starting', apiStartedAt: Date.now() };
}

export function markApiReady(): void {
  state = { ...state, apiStatus: 'ready' };
}

/** Lets the renderer go: it opens the app and shows its usual "server unreachable" state. */
export function markApiFailed(): void {
  state = { ...state, apiStatus: 'failed' };
}
