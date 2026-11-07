import { describe, it, expect } from 'vitest';
import {
  DEVICE_PLATFORM_VALUES,
  MANGA_STATUS_VALUES,
  NOTIFICATION_CHANNEL_KIND_VALUES,
  SHELF_STATUS_VALUES,
  TRACKER_SERVICE_VALUES,
  TRANSLATE_PROVIDER_VALUES,
} from '@projekt-manga/types';
import {
  DEVICE_PLATFORMS,
  mangaStatusSchema,
  notificationChannelKinds,
  SHELF_STATUSES,
  TRACKER_SERVICES,
  translateProviders,
} from '@projekt-manga/schemas';

/**
 * `packages/schemas` can't depend on `packages/types`, so each of these lists exists twice.
 * This is what keeps the copies equal: a value added to one side only would pass the type
 * checks and then be refused at the API.
 */
describe('enums shared between types and schemas', () => {
  it.each([
    ['shelf statuses', SHELF_STATUS_VALUES, SHELF_STATUSES],
    ['tracker services', TRACKER_SERVICE_VALUES, TRACKER_SERVICES],
    ['device platforms', DEVICE_PLATFORM_VALUES, DEVICE_PLATFORMS],
    ['manga statuses', MANGA_STATUS_VALUES, mangaStatusSchema.options],
    ['notification channels', NOTIFICATION_CHANNEL_KIND_VALUES, notificationChannelKinds],
    ['translation providers', TRANSLATE_PROVIDER_VALUES, translateProviders],
  ])('%s match', (_name, fromTypes, fromSchemas) => {
    expect([...fromSchemas].sort()).toEqual([...fromTypes].sort());
  });
});
