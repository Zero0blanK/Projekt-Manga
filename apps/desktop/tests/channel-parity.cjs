const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DESKTOP_CHANNELS } = require('../dist/shared/config.js');

// The sandboxed preload cannot import shared/config (see the header of preload/index.ts),
// so it repeats every channel name as a literal. A name that drifts fails silently at
// runtime: the invoke just rejects, or `window.desktop` loses a method. These tests are
// what "must stay in sync" rests on.

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const read = (file) => fs.readFileSync(file, 'utf8');

/** Every 'desktop:…' string literal in a source file, comments excluded. */
const channelLiterals = (file) => {
  const code = read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return new Set([...code.matchAll(/['"`](desktop:[a-z0-9:-]+)['"`]/g)].map((m) => m[1]));
};

const mainFiles = fs
  .readdirSync(src('main'), { recursive: true })
  .filter((name) => name.endsWith('.ts'))
  .map((name) => src('main', name));

const shared = new Set(Object.values(DESKTOP_CHANNELS));
/** Channels the main process names with its own literals (archives, unlock, commands). */
const mainLiterals = new Set(mainFiles.flatMap((file) => [...channelLiterals(file)]));
const knownToMain = new Set([...shared, ...mainLiterals]);

test('the preload names every shared channel', () => {
  const preload = channelLiterals(src('preload', 'index.ts'));
  const missing = [...shared].filter((channel) => !preload.has(channel));
  assert.deepEqual(missing, [], 'in DESKTOP_CHANNELS but not in preload/index.ts');
});

test('the preloads name no channel the main process does not know', () => {
  for (const file of ['index.ts', 'lock.ts']) {
    const unknown = [...channelLiterals(src('preload', file))].filter(
      (channel) => !knownToMain.has(channel),
    );
    assert.deepEqual(unknown, [], `in preload/${file} but nowhere in the main process`);
  }
});

test('every shared channel is used by the main process', () => {
  const main = mainFiles.map(read).join('\n');
  const unused = Object.keys(DESKTOP_CHANNELS).filter(
    (key) => !new RegExp(`DESKTOP_CHANNELS\\.${key}\\b`).test(main),
  );
  assert.deepEqual(unused, [], 'in DESKTOP_CHANNELS but never referenced under src/main');
});

test('shared channel names are unique', () => {
  assert.equal(shared.size, Object.keys(DESKTOP_CHANNELS).length);
});
