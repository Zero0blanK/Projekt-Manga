const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations } = require('../dist/main/db/migrate.js');
const chapterState = require('../dist/main/db/chapter-state.js');
// The server runs this same table (apps/server/tests/readingProgress.test.ts), which is
// what keeps the two implementations of the rule from drifting apart.
const cases = require('../../../packages/types/fixtures/reading-progress-cases.json');

const T1 = '2026-08-10T00:00:00.000Z';
const T2 = '2026-08-20T00:00:00.000Z';

function withDb(run) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    for (const id of ['a', 'b']) {
      db.prepare(
        `INSERT INTO chapter (id, source, manga_slug, source_chapter_key, chapter_number, updated_at)
         VALUES (?, 'source-a', 'slug-1', ?, 0, ?)`,
      ).run(id, id, T1);
    }
    return run(db);
  } finally {
    db.close();
  }
}

const row = (db, id) => {
  const state = db
    .prepare(
      `SELECT is_read, is_bookmark, last_page_read, updated_at FROM chapter_state WHERE chapter_id = ?`,
    )
    .get(id);
  return state && { ...state };
};
const ints = (state) => ({
  is_read: state.is_read ? 1 : 0,
  is_bookmark: state.is_bookmark ? 1 : 0,
  last_page_read: state.last_page_read,
});

for (const { name, a, b, expect } of cases.fold) {
  test(`fold: ${name}`, () => {
    assert.deepEqual(chapterState.foldReadingProgress(a, b), expect);
    assert.deepEqual(chapterState.foldReadingProgress(b, a), expect);
    // The same rule through the table, where states are stored as 0/1.
    withDb((db) => {
      chapterState.overwriteChapterState(db, 'a', a, T1);
      chapterState.foldChapterState(db, 'a', ints(b), T2, 'always');
      assert.deepEqual(row(db, 'a'), { ...ints(expect), updated_at: T2 });
    });
  });
}

for (const { name, local_updated_at, pulled_updated_at, replaces } of cases.pull) {
  test(`pull: ${name}`, () => {
    assert.equal(chapterState.pulledStateReplaces(local_updated_at, pulled_updated_at), replaces);
    withDb((db) => {
      const local = { is_read: true, is_bookmark: true, last_page_read: 9 };
      const pulled = { is_read: false, is_bookmark: false, last_page_read: 2 };
      chapterState.overwriteChapterState(db, 'a', local, local_updated_at);
      chapterState.adoptPulledChapterState(db, 'a', pulled, pulled_updated_at);
      assert.deepEqual(
        row(db, 'a'),
        replaces
          ? { ...ints(pulled), updated_at: pulled_updated_at }
          : { ...ints(local), updated_at: local_updated_at },
      );
    });
  });
}

test('a fold that changes nothing is not stamped as a fresh edit', () => {
  withDb((db) => {
    chapterState.overwriteChapterState(db, 'a', { is_read: true, last_page_read: 9 }, T1);
    chapterState.foldChapterState(db, 'a', { is_read: 1, last_page_read: 4 }, T2, 'if-changed');
    assert.equal(row(db, 'a').updated_at, T1);
    chapterState.foldChapterState(db, 'a', { last_page_read: 12 }, T2, 'if-changed');
    assert.deepEqual(row(db, 'a'), {
      is_read: 1,
      is_bookmark: 0,
      last_page_read: 12,
      updated_at: T2,
    });
  });
});

test('folding one chapter into another moves a state the other lacks, stamp included', () => {
  withDb((db) => {
    chapterState.overwriteChapterState(db, 'a', { is_bookmark: true, last_page_read: 3 }, T1);
    chapterState.foldChapterStateInto(db, 'a', 'b', T2);
    assert.equal(row(db, 'a'), undefined);
    assert.deepEqual(row(db, 'b'), {
      is_read: 0,
      is_bookmark: 1,
      last_page_read: 3,
      updated_at: T1,
    });
  });
});

test('folding one chapter into another keeps the furthest of both', () => {
  withDb((db) => {
    chapterState.overwriteChapterState(db, 'a', { is_read: true, last_page_read: 3 }, T1);
    chapterState.overwriteChapterState(db, 'b', { is_bookmark: true, last_page_read: 8 }, T1);
    chapterState.foldChapterStateInto(db, 'a', 'b', T2);
    assert.deepEqual(row(db, 'b'), {
      is_read: 1,
      is_bookmark: 1,
      last_page_read: 8,
      updated_at: T2,
    });
  });
});

test('a seed never replaces a stored state', () => {
  withDb((db) => {
    chapterState.seedChapterState(db, 'a', { is_read: true, last_page_read: 5 }, T1);
    chapterState.seedChapterState(db, 'a', { is_read: false, last_page_read: 0 }, T2);
    assert.deepEqual(row(db, 'a'), {
      is_read: 1,
      is_bookmark: 0,
      last_page_read: 5,
      updated_at: T1,
    });
  });
});

test("the reader's own edits are direct: paging back and marking unread both go back", () => {
  withDb((db) => {
    chapterState.overwriteChapterState(db, 'a', { is_bookmark: true, last_page_read: 9 }, T1);
    chapterState.setChapterPage(db, 'a', 4, T2);
    assert.deepEqual(row(db, 'a'), {
      is_read: 0,
      is_bookmark: 1,
      last_page_read: 4,
      updated_at: T2,
    });
    chapterState.setChapterRead(db, 'a', true, T2);
    assert.equal(row(db, 'a').last_page_read, 4);
    chapterState.setChapterRead(db, 'a', false, T2);
    assert.deepEqual(row(db, 'a'), {
      is_read: 0,
      is_bookmark: 1,
      last_page_read: 0,
      updated_at: T2,
    });
  });
});
