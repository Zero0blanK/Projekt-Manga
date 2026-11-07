const { test } = require('node:test');
const assert = require('node:assert/strict');
const { halve, pushableRows, splitIntoBatches } = require('../dist/main/sync-rows.js');

const NOW = '2026-11-05T00:00:00.000Z';
const empty = () => ({
  library: [],
  manga_state: [],
  chapter_state: [],
  manga_category: [],
  history: [],
});
const history = (overrides = {}) => ({
  id: 'h1',
  source: 'src',
  manga_id: null,
  manga_slug: 'slug',
  title: 'A title',
  thumbnail_url: null,
  source_chapter_key: null,
  read_at: NOW,
  last_read: NOW,
  pages_read: 1,
  time_read: 1,
  deleted_at: null,
  ...overrides,
});

test('keeps good rows and sets aside what the server would refuse', () => {
  const pending = {
    ...empty(),
    history: [
      history(),
      history({ id: 'fraction', time_read: 1.5 }),
      history({ id: 'empty-source', source: '' }),
      history({ id: 'long-title', title: 'x'.repeat(256) }),
    ],
    chapter_state: [
      {
        source: 's'.repeat(256),
        manga_slug: 'slug',
        source_chapter_key: 'key',
        is_read: true,
        is_bookmark: false,
        last_page_read: 0,
        updated_at: NOW,
      },
    ],
  };

  const { rows, rejected } = pushableRows(pending);

  assert.deepEqual(
    rows.history.map((row) => row.id),
    ['h1'],
  );
  assert.equal(rows.chapter_state.length, 0);
  assert.equal(rejected, 4);
});

test('splits a large push within each domain’s limit', () => {
  const pending = {
    ...empty(),
    library: Array.from({ length: 2500 }, (_, index) => ({
      manga_id: `m${index}`,
      deleted_at: null,
      updated_at: NOW,
    })),
    chapter_state: Array.from({ length: 6000 }, () => ({})),
  };

  const batches = splitIntoBatches(pending);

  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => [batch.library.length, batch.chapter_state.length]),
    [
      [1000, 5000],
      [1000, 1000],
      [500, 0],
    ],
  );
});

test('has no batches for nothing to push', () => {
  assert.deepEqual(splitIntoBatches(empty()), []);
});

test('halves a batch across domains, keeping every row, and stops at one', () => {
  const batch = {
    ...empty(),
    library: [{ manga_id: 'a' }, { manga_id: 'b' }],
    history: [history()],
  };

  const [first, second] = halve(batch);

  assert.equal(first.library.length + first.history.length, 2);
  assert.equal(second.library.length + second.history.length, 1);
  assert.equal(halve({ ...empty(), history: [history()] }), null);
});
