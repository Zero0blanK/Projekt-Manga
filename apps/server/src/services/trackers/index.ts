import { TRACKER_SERVICE_VALUES, type TrackerService } from '@projekt-manga/types';
import anilistTracker from './anilist.tracker.js';
import malTracker from './mal.tracker.js';
import kitsuTracker from './kitsu.tracker.js';
import mangaUpdatesTracker from './mangaupdates.tracker.js';
import shikimoriTracker from './shikimori.tracker.js';
import bangumiTracker from './bangumi.tracker.js';
import komgaTracker from './komga.tracker.js';
import kavitaTracker from './kavita.tracker.js';
import type { TrackerAdapter, TrackerAuthKind } from './tracker.interface.js';
import { ValidationError } from '../../utils/customErrors.js';
const registry: Partial<Record<TrackerService, TrackerAdapter>> = {
  ANILIST: anilistTracker,
  MYANIMELIST: malTracker,
  KITSU: kitsuTracker,
  MANGAUPDATES: mangaUpdatesTracker,
  SHIKIMORI: shikimoriTracker,
  BANGUMI: bangumiTracker,
  KOMGA: komgaTracker,
  KAVITA: kavitaTracker,
};

export function getTrackerAdapter(tracker: TrackerService): TrackerAdapter {
  const adapter = registry[tracker];
  if (!adapter) {
    throw new ValidationError(`Tracker "${tracker}" is not supported yet`);
  }
  return adapter;
}

export interface TrackerAvailability {
  tracker: TrackerService;
  label: string;
  auth_kind: TrackerAuthKind;
  /** False when this server is missing the configuration the tracker needs. */
  available: boolean;
}

/** Every registered tracker in TrackerService order, for the settings UI. */
export function listTrackerAvailability(): TrackerAvailability[] {
  return TRACKER_SERVICE_VALUES.flatMap((tracker) => {
    const adapter = registry[tracker];
    return adapter
      ? [
          {
            tracker,
            label: adapter.label,
            auth_kind: adapter.authKind,
            available: adapter.isConfigured(),
          },
        ]
      : [];
  });
}

export type {
  TrackerAdapter,
  TrackerAuthKind,
  TrackerCredentials,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerTokens,
  TrackerRefreshResult,
} from './tracker.interface.js';
