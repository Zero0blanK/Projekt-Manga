const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('a revoked remote session clears both the encrypted cache and renderer cookie', async () => {
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  let cachedSession = {
    user_id: 'reader-1',
    email: 'reader@example.test',
    session_id: 'revoked-session',
  };
  const removedCookies = [];
  const requests = [];
  const electron = {
    session: {
      defaultSession: {
        cookies: {
          remove: async (url, name) => removedCookies.push({ url, name }),
        },
      },
    },
  };

  // Matches either separator: CI runs this on Linux as well as Windows.
  const fromSync = (parent) => /[\\/]main[\\/]sync\.js$/.test(parent?.filename ?? '');

  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return electron;
      if (request === './db/local-store' && fromSync(parent)) {
        return { localStore: {} };
      }
      if (request === './auth-cache' && fromSync(parent)) {
        return {
          getCachedSession: () => cachedSession,
          clearCachedSession: () => {
            cachedSession = null;
          },
        };
      }
      if (request === '../shared/config' && fromSync(parent)) {
        return { SESSION_COOKIE_NAME: 'pm_session', resolveWebUrl: () => 'http://localhost:3000' };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), cookie: init.headers.Cookie });
      return new Response(JSON.stringify({ success: false, message: 'Session expired' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { runSync } = require('../dist/main/sync.js');
    await assert.rejects(runSync('https://reader.example.test/api'), /Session expired/);
    assert.equal(cachedSession, null);
    assert.deepEqual(removedCookies, [
      { url: 'http://localhost:3000', name: 'pm_session' },
      { url: 'https://reader.example.test', name: 'pm_session' },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await runSync('https://reader.example.test/api'), null);
    assert.deepEqual(requests, [
      {
        url: 'https://reader.example.test/api/sync/generation',
        cookie: 'pm_session=revoked-session',
      },
    ]);
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});
