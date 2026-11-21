import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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

/**
 * A local "download host": path → body. Redirects go only to targets a test registers
 * here (`/redirect/<name>`), never to one named in the request itself.
 */
const files = new Map<string, Buffer>();
const redirects = new Map<string, string>();
let mirror: http.Server;
let mirrorUrl = '';
beforeAll(async () => {
  mirror = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/redirect/')) {
      const target = redirects.get(url.pathname.slice('/redirect/'.length));
      if (target) response.writeHead(302, { Location: target }).end();
      else response.writeHead(404).end();
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
    redirects.set('away', 'http://localhost:1/part');
    await expect(
      downloadVerified(new URL(`${mirrorUrl}/redirect/away`), path.join(root, 'b'), sha('x'), {}),
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
