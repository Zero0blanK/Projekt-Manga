import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import request from 'supertest';

vi.mock('../src/services/sandboxedSourceRegistry.service.js', () => ({
  getInstalledSandboxedSource: vi.fn(async () => undefined),
  getInstalledSandboxedSources: vi.fn(async () => []),
}));

import app from '../src/app.js';
import { announceEngineChange } from '../src/utils/libraryChanges.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderManagedBlock, withManagedBlock } from '../src/services/suwayomi/engine/config.js';
import {
  downloadVerified,
  setEngineDownloadsForTests,
  type RuntimeRelease,
} from '../src/services/suwayomi/engine/download.js';
import { installEngine, removeEngine } from '../src/services/suwayomi/engine/install.js';
import {
  enginePaths,
  readRecord,
  setEngineRootForTests,
} from '../src/services/suwayomi/engine/layout.js';
import { runtimePlatform, type ServerRelease } from '../src/services/suwayomi/engine/manifest.js';
import {
  engineAnswers,
  engineProcess,
  setEngineLauncherForTests,
  stopStaleEngine,
} from '../src/services/suwayomi/engine/process.js';
import { isSafeEntryName } from '../src/services/suwayomi/engine/unpack.js';
import { suwayomiGraphql } from '../src/services/suwayomi/client.js';
// Registers the running engine as the built-in connection, as server.ts does at start.
import '../src/services/suwayomi/engine/index.js';
import {
  readSuwayomiConnection,
  saveSuwayomiSettings,
  setBuiltInConnectionProvider,
  setSuwayomiMode,
  setSuwayomiSettingsFileForTests,
  getSuwayomiSettings,
} from '../src/services/suwayomi/settings.js';

/**
 * The built-in extension engine, without Java and without the network: a local mirror
 * stands in for GitHub and Adoptium, and tests/fixtures/fake-engine.mjs for Suwayomi.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeEngine = path.join(here, 'fixtures', 'fake-engine.mjs');
const sha = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** A local "download host": path → body, plus /redirect?to= for redirect tests. */
const files = new Map<string, Buffer>();
let mirror: http.Server;
let mirrorUrl = '';
beforeAll(async () => {
  mirror = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/redirect') {
      response.writeHead(302, { Location: url.searchParams.get('to') ?? '/' }).end();
      return;
    }
    const body = files.get(url.pathname);
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Length': body.length });
    response.end(body);
  });
  await new Promise<void>((resolve) => mirror.listen(0, '127.0.0.1', resolve));
  const address = mirror.address() as { port: number };
  mirrorUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(() => mirror.close());

let root = '';
const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-engine-'));
  setEngineRootForTests(path.join(root, 'engine'));
  setSuwayomiSettingsFileForTests(path.join(root, 'suwayomi.json'));
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  setEngineDownloadsForTests({
    fetch: (url, init) => fetch(url, init),
    hosts: ['127.0.0.1'],
    allowHttp: true,
  });
  setEngineLauncherForTests({
    launcher: (javaArgs) => ({ command: process.execPath, args: [fakeEngine, ...javaArgs] }),
    readyTimeoutMs: 15_000,
    restartDelaysMs: [100, 100, 100],
  });
  files.clear();
});
afterEach(async () => {
  await engineProcess.stop();
  setEngineDownloadsForTests(null);
  setEngineLauncherForTests(null);
  setEngineRootForTests(null);
  setSuwayomiSettingsFileForTests(null);
  if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  await fsp.rm(root, { recursive: true, force: true });
});

/** The system tar (bsdtar in System32 on Windows), for building a test runtime archive. */
function tar(args: string[]) {
  const command =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  execFileSync(command, args, { windowsHide: true });
}

/** A runtime archive like Temurin's: one top folder with bin/java in it. */
async function runtimeRelease(version: string): Promise<RuntimeRelease> {
  const build = path.join(root, `build-${version}`);
  const bin = path.join(build, `jdk-${version}-jre`, 'bin');
  await fsp.mkdir(bin, { recursive: true });
  await fsp.writeFile(path.join(bin, process.platform === 'win32' ? 'java.exe' : 'java'), 'java');
  const archive = path.join(root, `runtime-${version}.tar.gz`);
  tar(['-czf', archive, '-C', build, `jdk-${version}-jre`]);
  const body = await fsp.readFile(archive);
  files.set(`/runtime-${version}.tar.gz`, body);
  return {
    version,
    url: new URL(`${mirrorUrl}/runtime-${version}.tar.gz`),
    sha256: sha(body),
    size: body.length,
    archive: 'tar.gz',
  };
}

/** A server "jar" whose contents choose the fake engine's behaviour. */
function serverRelease(version: string, behaviour = 'ok', checksumOf = behaviour): ServerRelease {
  const asset = `Suwayomi-Server-${version}.jar`;
  files.set(
    `/Suwayomi/Suwayomi-Server/releases/download/${version}/${asset}`,
    Buffer.from(behaviour),
  );
  return { version, asset, sha256: sha(checksumOf), size: Buffer.byteLength(behaviour) };
}

/** Downloads go to github.com in the real code; the mirror answers for it here. */
function useMirrorForGithub() {
  setEngineDownloadsForTests({
    fetch: (url, init) => {
      const local = new URL(url.pathname + url.search, mirrorUrl);
      return fetch(url.hostname === 'github.com' ? local : url, init);
    },
    hosts: ['127.0.0.1', 'github.com'],
    allowHttp: true,
  });
}

describe('engine config', () => {
  const config = { port: 4321, username: 'u', password: 'p"w' };

  it('locks the engine to this machine, with a login and no user interface of its own', () => {
    const block = renderManagedBlock(config);
    expect(block).toContain('server.ip = "127.0.0.1"');
    expect(block).toContain('server.port = 4321');
    expect(block).toContain('server.authMode = "BASIC_AUTH"');
    expect(block).toContain('server.authPassword = "p\\"w"');
    for (const off of ['webUIEnabled', 'initialOpenInBrowserEnabled', 'systemTrayEnabled']) {
      expect(block).toContain(`server.${off} = false`);
    }
    expect(block).toContain('server.globalUpdateInterval = 0');
    expect(block).toContain('server.autoDownloadNewChapters = false');
  });

  it("replaces the last start's block and keeps the engine's own settings", () => {
    const first = withManagedBlock(
      'server.extensionRepos = ["https://repo.test/index.min.json"]\n',
      config,
    );
    const second = withManagedBlock(first, { ...config, port: 5555 });
    expect(second).toContain('server.extensionRepos');
    expect(second).toContain('server.port = 5555');
    expect(second).not.toContain('server.port = 4321');
    expect(second.match(/managed settings: rewritten/g)).toHaveLength(1);
  });
});

describe('engine downloads', () => {
  it('keeps a download only when it matches its published checksum', async () => {
    files.set('/part', Buffer.from('engine part'));
    const target = path.join(root, 'part');
    const seen: number[] = [];
    await downloadVerified(new URL(`${mirrorUrl}/part`), target, sha('engine part'), {
      onProgress: (p) => seen.push(p.received),
    });
    expect(await fsp.readFile(target, 'utf8')).toBe('engine part');
    expect(seen.at(-1)).toBe(11);

    await expect(
      downloadVerified(new URL(`${mirrorUrl}/part`), target, sha('something else'), {}),
    ).rejects.toThrow(/checksum/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses hosts other than the publishers, also through a redirect', async () => {
    files.set('/part', Buffer.from('x'));
    setEngineDownloadsForTests({
      fetch: (url, init) => fetch(url, init),
      hosts: ['localhost'],
      allowHttp: true,
    });
    await expect(
      downloadVerified(new URL(`${mirrorUrl}/part`), path.join(root, 'a'), sha('x'), {}),
    ).rejects.toThrow(/not allowed/);
    setEngineDownloadsForTests({
      fetch: (url, init) => fetch(url, init),
      hosts: ['127.0.0.1'],
      allowHttp: true,
    });
    const away = encodeURIComponent('http://localhost:1/part');
    await expect(
      downloadVerified(
        new URL(`${mirrorUrl}/redirect?to=${away}`),
        path.join(root, 'b'),
        sha('x'),
        {},
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it('refuses unsafe archive entries', () => {
    expect(isSafeEntryName('jdk-21/bin/java')).toBe(true);
    for (const bad of ['/etc/passwd', '../outside', 'jdk/../../x', 'C:/Windows/x', '..\\x']) {
      expect(isSafeEntryName(bad)).toBe(false);
    }
  });
});

describe('installing the engine', () => {
  it.skipIf(!runtimePlatform())('puts the runtime and jar in place and records them', async () => {
    useMirrorForGithub();
    const runtime = await runtimeRelease('21.0.1');
    const record = await installEngine({ server: serverRelease('v1'), runtime });
    expect(record.active).toEqual({ server: 'v1', runtime: '21.0.1' });
    expect(record.unverified).toBe(false);
    expect(fs.existsSync(enginePaths.serverJar('v1'))).toBe(true);
    expect(fs.existsSync(enginePaths.stagingDir())).toBe(false);
    expect(readRecord()?.login.username).toBe('projektmanga');
  });

  it.skipIf(!runtimePlatform())(
    'never replaces a working engine with a failed download',
    async () => {
      useMirrorForGithub();
      const runtime = await runtimeRelease('21.0.1');
      await installEngine({ server: serverRelease('v1'), runtime });
      // v2's published checksum doesn't match what is downloaded.
      await expect(
        installEngine({ server: serverRelease('v2', 'ok', 'tampered'), runtime }),
      ).rejects.toThrow(/checksum/);
      expect(readRecord()?.active.server).toBe('v1');
      expect(fs.existsSync(enginePaths.serverDir('v2'))).toBe(false);
      expect(fs.existsSync(enginePaths.serverJar('v1'))).toBe(true);
    },
  );

  it.skipIf(!runtimePlatform())(
    'removes the engine, keeping its data only when asked',
    async () => {
      useMirrorForGithub();
      await installEngine({ server: serverRelease('v1'), runtime: await runtimeRelease('21.0.1') });
      await fsp.mkdir(enginePaths.dataDir(), { recursive: true });
      await removeEngine({ keepData: true });
      expect(readRecord()).toBeNull();
      expect(fs.existsSync(enginePaths.dataDir())).toBe(true);
      await removeEngine({ keepData: false });
      expect(fs.existsSync(enginePaths.dataDir())).toBe(false);
    },
  );
});

describe('running the engine', () => {
  it.skipIf(!runtimePlatform())(
    'starts it, answers with its login, and stops it with nothing left',
    async () => {
      useMirrorForGithub();
      await installEngine({ server: serverRelease('v1'), runtime: await runtimeRelease('21.0.1') });
      await engineProcess.start();
      expect(engineProcess.status().state).toBe('running');
      const connection = engineProcess.currentConnection();
      expect(connection?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await engineAnswers(connection!)).toBe(true);
      // Without the login it is refused.
      expect(await engineAnswers({ ...connection!, authorization: 'Basic eDp5' })).toBe(false);
      const pid = JSON.parse(await fsp.readFile(enginePaths.pidFile(), 'utf8')).pid as number;

      await engineProcess.stop();
      expect(engineProcess.status().state).toBe('stopped');
      expect(engineProcess.currentConnection()).toBeNull();
      expect(fs.existsSync(enginePaths.pidFile())).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it.skipIf(!runtimePlatform())(
    'stops anything the engine started, too',
    { timeout: 30_000 },
    async () => {
      useMirrorForGithub();
      await installEngine({
        server: serverRelease('v1', 'with-helper'),
        runtime: await runtimeRelease('21.0.1'),
      });
      await engineProcess.start();
      const helper = Number(
        await fsp.readFile(path.join(enginePaths.dataDir(), 'helper.pid'), 'utf8'),
      );
      expect(() => process.kill(helper, 0)).not.toThrow();
      await engineProcess.stop();
      await expect
        .poll(
          () => {
            try {
              process.kill(helper, 0);
              return 'alive';
            } catch {
              return 'gone';
            }
          },
          { timeout: 10_000 },
        )
        .toBe('gone');
    },
  );

  it.skipIf(!runtimePlatform())('restarts it after a crash', { timeout: 40_000 }, async () => {
    useMirrorForGithub();
    await installEngine({
      server: serverRelease('v1', 'crash-once'),
      runtime: await runtimeRelease('21.0.1'),
    });
    await engineProcess.start();
    const firstPort = engineProcess.currentConnection()?.baseUrl;
    // It crashes after ~400 ms, then comes back on its own.
    await expect
      .poll(() => engineProcess.currentConnection()?.baseUrl ?? null, { timeout: 15_000 })
      .not.toBe(firstPort);
    await expect.poll(() => engineProcess.status().state, { timeout: 15_000 }).toBe('running');
    expect(await engineAnswers(engineProcess.currentConnection()!)).toBe(true);
  });

  it.skipIf(!runtimePlatform())(
    'gives up after three retries, with its last output',
    { timeout: 40_000 },
    async () => {
      useMirrorForGithub();
      await installEngine({
        server: serverRelease('v1', 'broken'),
        runtime: await runtimeRelease('21.0.1'),
      });
      await engineProcess.start();
      await expect.poll(() => engineProcess.status().state, { timeout: 30_000 }).toBe('error');
      expect(engineProcess.status().lastLines.join('\n')).toContain('broken build');
      expect(engineProcess.currentConnection()).toBeNull();
    },
  );

  it.skipIf(!runtimePlatform())(
    'goes back to the previous version when an update does not start',
    async () => {
      useMirrorForGithub();
      const runtime = await runtimeRelease('21.0.1');
      await installEngine({ server: serverRelease('v1'), runtime });
      const updated = await installEngine({ server: serverRelease('v2', 'broken'), runtime });
      expect(updated).toMatchObject({
        active: { server: 'v2' },
        previous: { server: 'v1' },
        unverified: true,
      });

      await engineProcess.start();
      expect(engineProcess.status().state).toBe('running');
      expect(readRecord()).toMatchObject({
        active: { server: 'v1' },
        previous: null,
        unverified: false,
      });
      expect(fs.existsSync(enginePaths.serverDir('v2'))).toBe(false);
    },
  );

  it.skipIf(!runtimePlatform())(
    'keeps the previous version only until the update has started once',
    async () => {
      useMirrorForGithub();
      const runtime = await runtimeRelease('21.0.1');
      await installEngine({ server: serverRelease('v1'), runtime });
      await installEngine({ server: serverRelease('v2'), runtime });
      await engineProcess.start();
      expect(readRecord()).toMatchObject({
        active: { server: 'v2' },
        previous: null,
        unverified: false,
      });
      expect(fs.existsSync(enginePaths.serverDir('v1'))).toBe(false);
    },
  );
});

describe('a stale engine from a hard kill', () => {
  let dummy: ChildProcess | null = null;
  afterEach(() => {
    if (dummy?.exitCode === null) dummy.kill('SIGKILL');
    dummy = null;
  });

  async function spawnDummy(extra: string[]): Promise<number> {
    dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...extra], {
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return dummy.pid!;
  }

  it('stops only a process whose command line names our jar and data folder', async () => {
    await fsp.mkdir(path.dirname(enginePaths.pidFile()), { recursive: true });
    const jar = path.join(root, 'engine', 'server', 'v1', 'Suwayomi-Server.jar');
    const dataDir = path.join(root, 'engine', 'data');

    const stranger = await spawnDummy([]);
    await fsp.writeFile(enginePaths.pidFile(), JSON.stringify({ pid: stranger, jar, dataDir }));
    expect(await stopStaleEngine()).toBe('not-ours');
    expect(() => process.kill(stranger, 0)).not.toThrow();
    dummy?.kill('SIGKILL');

    const ours = await spawnDummy([jar, dataDir]);
    await fsp.writeFile(enginePaths.pidFile(), JSON.stringify({ pid: ours, jar, dataDir }));
    expect(await stopStaleEngine()).toBe('stopped');
    await expect.poll(() => dummy?.exitCode !== null || dummy?.signalCode !== null).toBe(true);
  }, 60_000);
});

describe('requests through the built-in engine', () => {
  it.skipIf(!runtimePlatform())(
    'reach the running engine, and say so when it is not running',
    async () => {
      useMirrorForGithub();
      await installEngine({ server: serverRelease('v1'), runtime: await runtimeRelease('21.0.1') });
      await setSuwayomiMode('built-in');
      await expect(suwayomiGraphql('{ aboutServer { name version } }')).rejects.toThrow(
        "The extension engine isn't running",
      );
      await engineProcess.start();
      await expect(
        suwayomiGraphql<{ aboutServer: { name: string } }>('{ aboutServer { name version } }'),
      ).resolves.toEqual({ aboutServer: { name: 'Suwayomi', version: 'fake' } });
    },
  );
});

describe('connection modes', () => {
  it('reads a settings file from before modes as an external server', async () => {
    await fsp.writeFile(
      path.join(root, 'suwayomi.json'),
      JSON.stringify({
        enabled: true,
        url: 'http://127.0.0.1:4567',
        username: null,
        password_encrypted: null,
      }),
    );
    setSuwayomiSettingsFileForTests(path.join(root, 'suwayomi.json'));
    expect(getSuwayomiSettings()?.mode).toBe('external');
    expect(readSuwayomiConnection()?.baseUrl).toBe('http://127.0.0.1:4567');
  });

  it('uses the running engine in built-in mode, and nothing when off', async () => {
    await saveSuwayomiSettings({ enabled: true, url: 'http://127.0.0.1:4567' } as never);
    setBuiltInConnectionProvider(() => ({
      baseUrl: 'http://127.0.0.1:9999',
      authorization: 'Basic x',
    }));
    await setSuwayomiMode('built-in');
    expect(readSuwayomiConnection()?.baseUrl).toBe('http://127.0.0.1:9999');
    // The external address is kept, to switch back.
    expect(getSuwayomiSettings()?.url).toBe('http://127.0.0.1:4567');
    await setSuwayomiMode('off');
    expect(readSuwayomiConnection()).toBeNull();
    await setSuwayomiMode('external');
    expect(readSuwayomiConnection()?.baseUrl).toBe('http://127.0.0.1:4567');
    setBuiltInConnectionProvider(() => engineProcess.currentConnection());
  });
});

describe('the engine API', () => {
  const api = () => request(app);

  it('is for the server host only', async () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    try {
      const res = await api().get('/api/suwayomi/engine').set('X-Forwarded-For', '203.0.113.9');
      expect(res.status).toBe(403);
    } finally {
      delete process.env.ADMIN_TOKEN;
    }
  });

  it('reports the engine as not installed, with its licenses', async () => {
    const res = await api().get('/api/suwayomi/engine');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ state: 'not-installed', installed: null, update: null });
    expect(res.body.data.licenses.map((l: { license: string }) => l.license)).toContain('MPL-2.0');
  });

  it('runs one download at a time, and cancels it', async () => {
    // A download that waits until it is cancelled.
    setEngineDownloadsForTests({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      hosts: ['api.adoptium.net'],
    });
    const first = await api().post('/api/suwayomi/engine/install');
    expect(first.status).toBe(202);
    expect(first.body.data.state).toBe('downloading');
    expect((await api().post('/api/suwayomi/engine/install')).status).toBe(409);
    await api().post('/api/suwayomi/engine/cancel');
    await expect
      .poll(async () => (await api().get('/api/suwayomi/engine')).body.data.state)
      .toBe('not-installed');
    // A cancel is not an error.
    expect((await api().get('/api/suwayomi/engine')).body.data.error).toBeNull();
  });

  it('shows a download that fails as an error', async () => {
    // Only the local mirror is allowed here, so the Java runtime lookup is refused.
    expect((await api().post('/api/suwayomi/engine/install')).status).toBe(202);
    await expect
      .poll(async () => (await api().get('/api/suwayomi/engine')).body.data.error)
      .toMatch(/not allowed/);
    expect((await api().get('/api/suwayomi/engine')).body.data.state).toBe('not-installed');
  });

  it.skipIf(!runtimePlatform())('starts, stops, and changes settings', async () => {
    useMirrorForGithub();
    await installEngine({ server: serverRelease('v1'), runtime: await runtimeRelease('21.0.1') });
    expect((await api().post('/api/suwayomi/engine/start')).body.data.state).toBe('running');
    const settings = await api()
      .put('/api/suwayomi/engine/settings')
      .send({ memory_mb: 1024, start_with_server: false });
    expect(settings.body.data).toMatchObject({ memoryMb: 1024, startWithServer: false });
    expect((await api().put('/api/suwayomi/engine/settings').send({ memory_mb: 64 })).status).toBe(
      400,
    );
    expect((await api().post('/api/suwayomi/engine/stop')).body.data.state).toBe('stopped');
  });

  it.skipIf(!runtimePlatform())(
    'reads and saves extension repositories through the engine',
    async () => {
      useMirrorForGithub();
      await installEngine({ server: serverRelease('v1'), runtime: await runtimeRelease('21.0.1') });
      // Not running: says so.
      expect((await api().get('/api/suwayomi/engine/repositories')).status).toBe(503);
      await api().post('/api/suwayomi/engine/start');
      const repo = 'https://repo.example/index.min.json';
      const saved = await api()
        .put('/api/suwayomi/engine/repositories')
        .send({ repositories: [repo, repo] });
      expect(saved.status).toBe(200);
      const listed = [{ url: repo, name: 'Example repository' }];
      expect(saved.body.data).toEqual(listed);
      expect((await api().get('/api/suwayomi/engine/repositories')).body.data).toEqual(listed);
      // A repository that isn't there is refused, in words, with no Java class names.
      const missing = await api()
        .put('/api/suwayomi/engine/repositories')
        .send({ repositories: [repo, 'https://repo.example/missing/index.min.json'] });
      expect(missing.status).toBe(503);
      expect(missing.body.message).toBe('Suwayomi: HTTP error 404');
      // Removing one.
      const emptied = await api()
        .put('/api/suwayomi/engine/repositories')
        .send({ repositories: [] });
      expect(emptied.body.data).toEqual([]);
      // Only https index URLs, without credentials.
      for (const bad of ['http://repo.example/index.json', 'https://u:p@repo.example/x.json']) {
        expect(
          (
            await api()
              .put('/api/suwayomi/engine/repositories')
              .send({ repositories: [bad] })
          ).status,
        ).toBe(400);
      }
    },
  );

  it.skipIf(!runtimePlatform())(
    'starts the engine when built-in is chosen, and stops it otherwise',
    async () => {
      useMirrorForGithub();
      await installEngine({ server: serverRelease('v1'), runtime: await runtimeRelease('21.0.1') });
      const chosen = await api().put('/api/suwayomi/mode').send({ mode: 'built-in' });
      expect(chosen.body.data.mode).toBe('built-in');
      expect(engineProcess.status().state).toBe('running');
      await api().put('/api/suwayomi/mode').send({ mode: 'off' });
      expect(engineProcess.status().state).toBe('stopped');
      // The external server needs its address saved first.
      expect((await api().put('/api/suwayomi/mode').send({ mode: 'external' })).status).toBe(400);
    },
  );

  it.skipIf(!runtimePlatform())('removes the engine, keeping its data when asked', async () => {
    useMirrorForGithub();
    await installEngine({ server: serverRelease('v1'), runtime: await runtimeRelease('21.0.1') });
    await fsp.mkdir(enginePaths.dataDir(), { recursive: true });
    const removed = await api().delete('/api/suwayomi/engine?keep_data=true');
    expect(removed.body.data.state).toBe('not-installed');
    expect(fs.existsSync(enginePaths.dataDir())).toBe(true);
    expect((await api().delete('/api/suwayomi/engine?keep_data=maybe')).status).toBe(400);
  });
});

describe('live engine status', () => {
  it('tells open library streams to re-read the engine status', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const received: string[] = [];
    const stream = http.get(`http://127.0.0.1:${port}/api/library-events/stream`, (res) => {
      res.on('data', (chunk: Buffer) => received.push(chunk.toString('utf8')));
    });
    try {
      await expect.poll(() => received.join('')).toContain('event: connected');
      announceEngineChange();
      announceEngineChange();
      await expect.poll(() => received.join('')).toContain('event: engine');
      // A burst becomes one event.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(received.join('').match(/event: engine/g)).toHaveLength(1);
    } finally {
      stream.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
