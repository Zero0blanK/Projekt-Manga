import { describe, expect, it, vi } from 'vitest';
import { matchesSourceFilters, emptySourceFilters } from '@/components/discover/source-filters';
import { scheduleSourceSearch } from '@/lib/source-search-queue';

describe('Source discovery controls', () => {
  it('preserves unknown and mixed catalogues and combines filters', () => {
    const mixed = { name: 'French Mixed', lang: 'fr', content_rating: 'mixed', isNSFW: false };
    expect(matchesSourceFilters(mixed, true, emptySourceFilters)).toBe(true);
    expect(
      matchesSourceFilters(mixed, true, {
        name: 'FRENCH',
        language: 'fr',
        rating: 'mixed',
        status: 'installed',
      }),
    ).toBe(true);
    expect(matchesSourceFilters(mixed, true, { ...emptySourceFilters, status: 'available' })).toBe(
      false,
    );
    expect(
      matchesSourceFilters({ name: 'Unknown', isNSFW: false }, false, {
        ...emptySourceFilters,
        language: 'unknown',
        rating: 'unknown',
      }),
    ).toBe(true);
  });
  it('matches any chosen setup language while keeping other filters combined', () => {
    const preferences = { ...emptySourceFilters, language: ['fr', 'id'], rating: 'mixed' };
    expect(
      matchesSourceFilters(
        { name: 'French', lang: 'fr', content_rating: 'mixed', isNSFW: false },
        true,
        preferences,
      ),
    ).toBe(true);
    expect(
      matchesSourceFilters(
        { name: 'Indonesian', lang: 'id', content_rating: 'mixed', isNSFW: false },
        true,
        preferences,
      ),
    ).toBe(true);
    expect(
      matchesSourceFilters(
        { name: 'English', lang: 'en', content_rating: 'mixed', isNSFW: false },
        true,
        preferences,
      ),
    ).toBe(false);
    expect(
      matchesSourceFilters(
        { name: 'French adult', lang: 'fr', content_rating: 'nsfw', isNSFW: true },
        true,
        preferences,
      ),
    ).toBe(false);
    expect(
      matchesSourceFilters({ name: 'English', lang: 'en', isNSFW: false }, true, {
        ...emptySourceFilters,
        language: [],
      }),
    ).toBe(true);
  });
  it('caps active requests at three and removes cancelled queued work', async () => {
    const releases: (() => void)[] = [];
    const request = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const promises = controllers.map((controller) =>
      scheduleSourceSearch(controller.signal, request),
    );
    const settled = Promise.allSettled(promises);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(3);
    controllers[3].abort();
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(4);
    releases.slice(1).forEach((release) => release());
    const results = await settled;
    expect(results[3].status).toBe('rejected');
    expect(results[4].status).toBe('fulfilled');
  });
});
