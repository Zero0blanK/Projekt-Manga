import { describe, expect, it } from 'vitest';
import {
  isNotificationMuted,
  notifiableNewChapters,
  parseCategoryIntervals,
  parseMutedCategories,
  resolveUpdateIntervalHours,
  updateBuckets,
} from '@/lib/update-schedule';

const members = {
  Daily: ['a', 'b'],
  Weekly: ['b', 'c'],
  Quiet: ['c'],
};

describe('resolveUpdateIntervalHours', () => {
  const base = {
    globalHours: 12,
    categoryIntervals: { Daily: 4, Weekly: 168 },
    categoryMembers: members,
  };

  it('uses the global interval for a title in no category with an interval', () => {
    expect(resolveUpdateIntervalHours('z', base)).toBe(12);
  });

  it('uses a category interval even when it is longer than the global one', () => {
    expect(resolveUpdateIntervalHours('c', base)).toBe(168);
  });

  it('picks the shortest interval when a title is in several categories', () => {
    expect(resolveUpdateIntervalHours('b', base)).toBe(4);
  });

  it('never goes below the source minimum', () => {
    expect(resolveUpdateIntervalHours('a', { ...base, sourceMinimumHours: 24 })).toBe(24);
  });

  it('clamps out-of-range values and ignores unusable ones', () => {
    expect(
      resolveUpdateIntervalHours('a', {
        globalHours: Number.NaN,
        categoryIntervals: { Daily: 0.1, Weekly: Number.NaN },
        categoryMembers: members,
      }),
    ).toBe(1);
    expect(
      resolveUpdateIntervalHours('z', {
        globalHours: 999,
        categoryIntervals: {},
        categoryMembers: undefined,
      }),
    ).toBe(168);
  });
});

describe('stored category settings', () => {
  it('parses an interval map and drops malformed entries', () => {
    expect(parseCategoryIntervals('{"Daily":4,"Bad":"x","Big":1000}')).toEqual({
      Daily: 4,
      Big: 168,
    });
    expect(parseCategoryIntervals('[1,2]')).toEqual({});
    expect(parseCategoryIntervals('{oops')).toEqual({});
    expect(parseCategoryIntervals(5)).toEqual({});
  });

  it('parses a muted list and drops malformed entries', () => {
    expect(parseMutedCategories('["Quiet",3]')).toEqual(['Quiet']);
    expect(parseMutedCategories('nope')).toEqual([]);
  });
});

describe('updateBuckets', () => {
  const entries = [
    { id: 'a', source: 's1' },
    { id: 'b', source: 's1' },
    { id: 'z', source: 's1' },
    { id: 'c', source: 's2' },
  ];

  it('splits a source by interval and keeps the plain source key for the default cadence', () => {
    const buckets = updateBuckets(entries, {
      globalHours: 12,
      sourceMinimumHours: () => null,
      categoryIntervals: { Daily: 4, Weekly: 168 },
      categoryMembers: members,
    });
    expect([...buckets.keys()].sort()).toEqual(['s1', 's1@4h', 's2@168h']);
    expect(buckets.get('s1@4h')?.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(buckets.get('s1')?.entries.map((e) => e.id)).toEqual(['z']);
  });

  it('folds a category interval under the source minimum into the default bucket', () => {
    const buckets = updateBuckets(entries.slice(0, 3), {
      globalHours: 12,
      sourceMinimumHours: () => 12,
      categoryIntervals: { Daily: 4 },
      categoryMembers: members,
    });
    expect([...buckets.keys()]).toEqual(['s1']);
    expect(buckets.get('s1')?.intervalHours).toBe(12);
  });
});

describe('notification muting', () => {
  it('mutes a title in any muted category', () => {
    expect(isNotificationMuted('c', ['Quiet'], members)).toBe(true);
    expect(isNotificationMuted('b', ['Quiet'], members)).toBe(false);
    expect(isNotificationMuted('b', ['Quiet'], undefined)).toBe(false);
  });

  it('counts only chapters from unmuted titles on notifying sources', () => {
    const sources: Record<string, string> = { a: 's1', b: 's2', c: 's1' };
    expect(
      notifiableNewChapters(
        { a: 2, b: 3, c: 5 },
        {
          sourceOf: (id) => sources[id],
          sourceNotifies: (source) => source !== 's2',
          mutedCategories: ['Quiet'],
          categoryMembers: members,
        },
      ),
    ).toBe(2);
  });
});
