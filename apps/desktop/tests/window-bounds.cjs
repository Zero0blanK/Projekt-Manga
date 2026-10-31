const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWindowState, restorableBounds } = require('../dist/main/window-bounds.js');

const MIN = { width: 1024, height: 680 };
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

test('saved window state is read strictly', () => {
  assert.deepEqual(
    parseWindowState({ x: 10.4, y: 20, width: 1300, height: 900, maximized: true }),
    {
      x: 10,
      y: 20,
      width: 1300,
      height: 900,
      maximized: true,
    },
  );
  for (const raw of [
    null,
    'x',
    {},
    { x: 0, y: 0, width: 0, height: 900 },
    { x: Number.NaN, y: 0, width: 800, height: 600 },
    { x: 0, y: 0, width: 1e9, height: 600 },
    { x: '0', y: 0, width: 800, height: 600 },
  ])
    assert.equal(parseWindowState(raw), null, JSON.stringify(raw));
});

test('a window reopens where it was while its title bar is on a screen', () => {
  const saved = { x: 2000, y: 100, width: 1400, height: 900, maximized: false };
  assert.deepEqual(restorableBounds(saved, [primary, right], MIN), {
    x: 2000,
    y: 100,
    width: 1400,
    height: 900,
  });
  // The second monitor was unplugged: open at the default instead.
  assert.equal(restorableBounds(saved, [primary], MIN), null);
  // Only a sliver of the title bar would show: not enough to grab.
  assert.equal(restorableBounds({ ...saved, x: 1900, y: 100 }, [primary], MIN), null);
  // Above the top of every screen.
  assert.equal(restorableBounds({ ...saved, x: 100, y: -500 }, [primary], MIN), null);
  assert.equal(restorableBounds(null, [primary], MIN), null);
});

test('a restored size fits its screen and respects the minimum', () => {
  assert.deepEqual(
    restorableBounds({ x: 0, y: 0, width: 5000, height: 4000, maximized: false }, [primary], MIN),
    { x: 0, y: 0, width: 1920, height: 1040 },
  );
  assert.deepEqual(
    restorableBounds({ x: 10, y: 10, width: 300, height: 200, maximized: false }, [primary], MIN),
    { x: 10, y: 10, width: 1024, height: 680 },
  );
});
