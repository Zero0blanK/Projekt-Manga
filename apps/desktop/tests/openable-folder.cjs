const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveOpenableFolder } = require('../dist/main/openable-folder.js');

test('opens an existing local folder', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-open-folder-'));
  try {
    // .native, like the fs/promises realpath the code uses: the JS realpathSync leaves a
    // Windows 8.3 short name (C:\Users\RUNNER~1) unexpanded, the native call does not.
    assert.equal(await resolveOpenableFolder(directory), fs.realpathSync.native(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses files, which shell.openPath would run', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-open-folder-'));
  const file = path.join(directory, 'payload.bat');
  fs.writeFileSync(file, 'echo hi');
  try {
    await assert.rejects(resolveOpenableFolder(file), /local folders/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses network, relative, missing and non-string paths', async () => {
  await assert.rejects(resolveOpenableFolder('\\\\attacker\\share\\x.exe'), /local folders/);
  await assert.rejects(resolveOpenableFolder('//attacker/share'), /local folders/);
  await assert.rejects(resolveOpenableFolder('relative/folder'), /local folders/);
  await assert.rejects(
    resolveOpenableFolder(path.join(os.tmpdir(), 'pm-definitely-missing-folder')),
    /no longer exists/,
  );
  await assert.rejects(resolveOpenableFolder(42), /No path/);
});
