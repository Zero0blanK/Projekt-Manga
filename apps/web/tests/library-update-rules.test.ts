import { describe, expect, it } from 'vitest';
import type { Manga } from '@/lib/manga-data';
import {
  NO_UPDATE_RULES,
  dueForSmartUpdate,
  entriesInGlobalUpdate,
  parseCategoryList,
} from '@/lib/library-update';

const title = (id: string, extra: Partial<Manga> = {}) =>
  ({ id, status: 'Ongoing', chapters: 10, progress: 1, ...extra }) as Manga;
const ids = (list: Manga[]) => list.map((m) => m.id);

const library = [
  title('caught-up'),
  title('behind', { progress: 0.5 }),
  title('unopened', { progress: undefined }),
  title('finished', { status: 'Completed' }),
  title('shelved'),
];
const shelf = { shelved: 'completed' as const };
const members = { Weekly: ['caught-up', 'behind'], Paused: ['behind'] };

describe('library update rules', () => {
  it('checks everything with no rules', () => {
    expect(entriesInGlobalUpdate(library, shelf, NO_UPDATE_RULES)).toHaveLength(5);
  });

  it('skips finished, unread and unstarted titles when asked', () => {
    const rules = { ...NO_UPDATE_RULES, skipCompleted: true };
    expect(ids(entriesInGlobalUpdate(library, shelf, rules))).toEqual([
      'caught-up',
      'behind',
      'unopened',
    ]);
    expect(
      ids(entriesInGlobalUpdate(library, shelf, { ...NO_UPDATE_RULES, skipUnread: true })),
    ).toEqual(['caught-up', 'finished', 'shelved']);
    expect(
      ids(entriesInGlobalUpdate(library, shelf, { ...NO_UPDATE_RULES, skipNotStarted: true })),
    ).not.toContain('unopened');
  });

  it('limits to included categories, with exclusions winning', () => {
    const rules = { ...NO_UPDATE_RULES, categoryMembers: members, includeCategories: ['Weekly'] };
    expect(ids(entriesInGlobalUpdate(library, shelf, rules))).toEqual(['caught-up', 'behind']);
    expect(
      ids(entriesInGlobalUpdate(library, shelf, { ...rules, excludeCategories: ['Paused'] })),
    ).toEqual(['caught-up']);
  });

  it('reads stored category lists defensively', () => {
    expect(parseCategoryList('["A","B"]')).toEqual(['A', 'B']);
    expect(parseCategoryList('[1,"A"]')).toEqual(['A']);
    expect(parseCategoryList('not json')).toEqual([]);
    expect(parseCategoryList(true)).toEqual([]);
  });
});

describe('smart update', () => {
  const now = Date.UTC(2026, 9, 28);
  const hours = (n: number) => new Date(now + n * 3600_000).toISOString();

  it('checks titles due within a day, overdue ones and ones without an estimate', () => {
    const estimates = new Map([
      ['caught-up', hours(12)],
      ['behind', hours(-48)],
      ['unopened', hours(72)],
    ]);
    expect(ids(dueForSmartUpdate(library, estimates, now))).toEqual([
      'caught-up',
      'behind',
      'finished',
      'shelved',
    ]);
  });

  it('checks everything when the estimates could not be loaded', () => {
    expect(dueForSmartUpdate(library, null, now)).toHaveLength(5);
  });
});
