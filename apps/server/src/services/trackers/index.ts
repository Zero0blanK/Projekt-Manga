import anilistTracker from './anilist.tracker.js';
import malTracker from './mal.tracker.js';
import type { TrackerAdapter } from './tracker.interface.js';
import { ValidationError } from '../../utils/customErrors.js';
import type { TrackerService } from '@projekt-manga/types';
const registry: Partial<Record<TrackerService, TrackerAdapter>> = {
  ANILIST: anilistTracker,
  MYANIMELIST: malTracker,
};

export function getTrackerAdapter(tracker: TrackerService): TrackerAdapter {
  const adapter = registry[tracker];
  if (!adapter) {
    throw new ValidationError(`Tracker "${tracker}" is not supported yet`);
  }
  return adapter;
}

export type {
  TrackerAdapter,
  TrackerMediaSearchResult,
  TrackerProgress,
  TrackerTokens,
  TrackerRefreshResult,
} from './tracker.interface.js';
