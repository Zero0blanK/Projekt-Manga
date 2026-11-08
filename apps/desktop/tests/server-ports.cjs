const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { findFreePort, PREFERRED_WEB_PORT } = require('../dist/main/servers.js');

const holdPort = (port) =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });

test('the built-in library keeps one web address from launch to launch', async () => {
  // A browser bookmark or open tab on the library only survives a restart if the port does.
  assert.equal(PREFERRED_WEB_PORT, 47811);
  const probe = await holdPort(0);
  const free = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.equal(await findFreePort(free), free);
});

test('a taken preferred port falls back to another free one instead of failing', async () => {
  const held = await holdPort(0);
  const taken = held.address().port;
  try {
    const port = await findFreePort(taken);
    assert.notEqual(port, taken);
    assert.ok(port > 0);
  } finally {
    await new Promise((resolve) => held.close(resolve));
  }
});

test('a packaged app starts the standalone web server, a monorepo run uses next start', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { resolveServerPaths } = require('../dist/main/servers.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-server-paths-'));
  const touch = (...parts) => {
    fs.mkdirSync(path.join(root, ...parts.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(root, ...parts), '');
  };
  try {
    touch('resources', 'server', 'dist', 'server.js');
    touch('resources', 'web', 'apps', 'web', 'server.js');
    touch('resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    const packaged = resolveServerPaths(path.join(root, 'resources'), path.join(root, 'none'));
    assert.equal(packaged.webStandalone, true);
    assert.equal(
      packaged.webEntry,
      path.join(root, 'resources', 'web', 'apps', 'web', 'server.js'),
    );
    assert.equal(packaged.webDir, path.join(root, 'resources', 'web', 'apps', 'web'));

    touch('repo', 'apps', 'server', 'dist', 'server.js');
    touch('repo', 'node_modules', 'next', 'dist', 'bin', 'next');
    const monorepo = resolveServerPaths(path.join(root, 'none'), path.join(root, 'repo'));
    assert.equal(monorepo.webStandalone, false);
    assert.equal(monorepo.webDir, path.join(root, 'repo', 'apps', 'web'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
