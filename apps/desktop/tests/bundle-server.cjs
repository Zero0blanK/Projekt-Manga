const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'bundle-server.mjs')));

/** A throwaway "server" whose src/server.ts imports one package from its own node_modules. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bundle-test-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  fs.mkdirSync(path.join(dir, 'out'));
  return dir;
}

test('the API bundle names what to do with a package that reads its own files', async () => {
  const { bundleServer } = await load();
  const dir = fixture({
    'src/server.ts': "import read from 'reads-own-files';\nconsole.log(read());\n",
    'node_modules/reads-own-files/package.json': '{"name":"reads-own-files","main":"index.js"}',
    'node_modules/reads-own-files/index.js':
      "const fs = require('fs'); module.exports = () => fs.readFileSync(__dirname + '/data.txt', 'utf8');\n",
  });
  try {
    await assert.rejects(
      bundleServer({ serverDir: dir, outDir: path.join(dir, 'out') }),
      (error) => {
        assert.match(error.message, /reads-own-files/);
        assert.match(error.message, /EXTERNAL in apps\/desktop\/scripts\/bundle-server\.mjs/);
        assert.match(error.message, /BUNDLED_LOCATION_USERS/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the API bundle names the entry to add for a native package', async () => {
  const { bundleServer } = await load();
  const dir = fixture({
    'src/server.ts': "import addon from 'native-addon';\nconsole.log(addon);\n",
    'node_modules/native-addon/package.json': '{"name":"native-addon","main":"index.js"}',
    'node_modules/native-addon/index.js': "module.exports = require('./addon.node');\n",
    'node_modules/native-addon/addon.node': 'not really a binary',
  });
  try {
    await assert.rejects(
      bundleServer({ serverDir: dir, outDir: path.join(dir, 'out') }),
      (error) => {
        assert.match(error.message, /native-addon contains a native binary/);
        assert.match(error.message, /'native-addon': 'Native binary \(\.node\)\.'/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the API bundle keeps external packages out and writes a source-mapped loader', async () => {
  const { bundleServer } = await load();
  const dir = fixture({
    'src/server.ts':
      "import bcrypt from 'bcrypt';\nimport pure from 'pure-js';\nconsole.log(bcrypt, pure);\n",
    'node_modules/pure-js/package.json': '{"name":"pure-js","main":"index.js"}',
    'node_modules/pure-js/index.js': 'module.exports = 42;\n',
  });
  try {
    const result = await bundleServer({ serverDir: dir, outDir: path.join(dir, 'out') });
    assert.deepEqual(result.externals, ['bcrypt']);
    const loader = fs.readFileSync(path.join(dir, 'out', 'server.js'), 'utf8');
    assert.match(loader, /process\.setSourceMapsEnabled\(true\)/);
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'app.mjs.map'), 'utf8'));
    // Named from the repository root (two levels above the server), never the build machine.
    const fromRoot = path
      .relative(path.resolve(dir, '..', '..'), path.join(dir, 'src', 'server.ts'))
      .replace(/\\/g, '/');
    assert.ok(map.sources.includes(`projekt-manga:///${fromRoot}`), map.sources.join(', '));
    assert.ok(map.sources.every((source) => source.startsWith('projekt-manga:///')));
    assert.match(fs.readFileSync(path.join(dir, 'out', 'app.mjs'), 'utf8'), /module\.exports = 42/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
