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
