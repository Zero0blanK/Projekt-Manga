const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startManagedServers } = require('../dist/main/managed-servers.js');
const config = require('../dist/shared/config.js');

// The start-up sequence with fakes for everything that touches Electron or spawns a
// process: what it decides, in what order, and what it reports.

const PATHS = { apiEntry: 'api/dist/server.js', webDir: 'web', webEntry: 'web/server.js' };

function harness(overrides = {}) {
  const events = [];
  const startupErrors = [];
  const servers = {
    apiPort: 41001,
    webPort: 47811,
    ready: Promise.resolve(),
    apiReady: Promise.resolve(),
  };
  const deps = {
    isPackaged: true,
    appPath: path.join('repo', 'apps', 'desktop'),
    resourcesPath: 'resources',
    userDataDir: 'userData',
    resolveTokenKey: () => 'key',
    onApiStarting: () => events.push('api-starting'),
    onApiReady: () => events.push('api-ready'),
    onApiFailed: () => events.push('api-failed'),
    recordStartupError: (stage, error) => startupErrors.push([stage, error.message]),
    shouldManageServers: (isPackaged) => isPackaged,
    resolveServerPaths: (resourcesPath, appRoot) => {
      events.push(`paths:${resourcesPath}:${appRoot}`);
      return PATHS;
    },
    startServers: async (...args) => {
      events.push('spawn');
      servers.args = args;
      return servers;
    },
    ...overrides,
  };
  return { deps, events, startupErrors, servers };
}

/** Lets promise callbacks attached inside the module run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function quietly(run) {
  const original = { warn: console.warn, error: console.error };
  console.warn = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    Object.assign(console, original);
    config.setManagedServerUrls(null);
  }
}

test('a build that does not manage its servers starts nothing', async () => {
  await quietly(async () => {
    const { deps, events } = harness({ isPackaged: false });
    assert.deepEqual(await startManagedServers(deps), { kind: 'unmanaged' });
    assert.deepEqual(events, []);
    assert.equal(config.resolveWebUrl(), config.DEFAULT_WEB_URL);
  });
});

test('a missing bundle falls back to whatever is already running', async () => {
  await quietly(async () => {
    const { deps, events } = harness({ resolveServerPaths: () => null });
    assert.deepEqual(await startManagedServers(deps), { kind: 'unmanaged' });
    assert.ok(!events.includes('spawn'));
    assert.ok(!events.includes('api-starting'));
  });
});

test('a managed start spawns, publishes the chosen addresses, then follows readiness', async () => {
  await quietly(async () => {
    const { deps, events, servers, startupErrors } = harness();
    const result = await startManagedServers(deps);

    assert.equal(result.kind, 'managed');
    assert.equal(result.apiBaseUrl, config.LOCAL_API_BASE_URL);
    assert.equal(result.webUrl, config.buildLocalWebUrl(47811));
    assert.equal(result.apiUrl, 'http://127.0.0.1:41001/api');
    // The window loader, the seed and sync all ask the config for these.
    assert.equal(config.resolveWebUrl(), result.webUrl);
    assert.equal(config.resolveApiUrl(), result.apiUrl);

    // The bundle is looked for from the repo root, two up from the app path.
    assert.deepEqual(events.slice(0, 3), ['paths:resources:repo', 'api-starting', 'spawn']);
    const [paths, databaseFile, bundlesDir, secrets] = servers.args;
    assert.equal(paths, PATHS);
    assert.equal(databaseFile, path.join('userData', 'projektmanga.db'));
    assert.equal(bundlesDir, path.join('userData', 'installed-extensions'));
    assert.deepEqual(secrets, { tokenEncryptionKey: 'key' });

    await settle();
    assert.deepEqual(events.slice(3), ['api-ready']);
    assert.deepEqual(startupErrors, []);
  });
});

test('the chosen addresses win over ones set in the environment', async () => {
  const previous = process.env.PROJEKT_MANGA_API_URL;
  process.env.PROJEKT_MANGA_API_URL = 'http://elsewhere.example/api';
  try {
    await quietly(async () => {
      assert.equal(config.resolveApiUrl(), 'http://elsewhere.example/api');
      const { deps } = harness();
      const result = await startManagedServers(deps);
      assert.equal(config.resolveApiUrl(), result.apiUrl);
    });
    // Back to the configured address once nothing is managed.
    assert.equal(config.resolveApiUrl(), 'http://elsewhere.example/api');
  } finally {
    if (previous === undefined) delete process.env.PROJEKT_MANGA_API_URL;
    else process.env.PROJEKT_MANGA_API_URL = previous;
  }
});

test('a start without an encryption key still starts', async () => {
  await quietly(async () => {
    const { deps, servers } = harness({
      resolveTokenKey: () => {
        throw new Error('keychain locked');
      },
    });
    assert.equal((await startManagedServers(deps)).kind, 'managed');
    assert.deepEqual(servers.args[3], { tokenEncryptionKey: undefined });
  });
});

test('servers that could not be spawned are a failure, not a development setup', async () => {
  await quietly(async () => {
    const { deps, events, startupErrors } = harness({
      startServers: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const result = await startManagedServers(deps);

    assert.equal(result.kind, 'failed');
    assert.equal(result.error.message, 'spawn ENOENT');
    assert.deepEqual(startupErrors, [['servers-start', 'spawn ENOENT']]);
    // The renderer is let off its "starting" screen.
    assert.deepEqual(events.slice(-2), ['api-starting', 'api-failed']);
    // Nothing was published: the configured addresses still answer.
    assert.equal(config.resolveWebUrl(), config.DEFAULT_WEB_URL);
  });
});

test('servers that spawn but never listen are reported, and the app is still told its addresses', async () => {
  await quietly(async () => {
    const timeout = new Error('API server did not start listening');
    const apiReady = Promise.reject(timeout);
    apiReady.catch(() => {});
    const ready = Promise.reject(timeout);
    const { deps, events, startupErrors } = harness({
      startServers: async () => ({ apiPort: 41001, webPort: 47811, ready, apiReady }),
    });
    const result = await startManagedServers(deps);

    assert.equal(result.kind, 'managed');
    await settle();
    assert.deepEqual(events.slice(-1), ['api-failed']);
    assert.deepEqual(startupErrors, [['servers-ready', 'API server did not start listening']]);
  });
});
