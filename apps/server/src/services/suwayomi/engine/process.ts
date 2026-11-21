import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { decryptToken } from '../../../utils/tokenCrypto.js';
import { GRAPHQL_PATH, ROOT_DIR_PROPERTY } from './constants.js';
import { writeEngineConfig } from './config.js';
import { confirmUpdate, rollBackUpdate } from './install.js';
import { enginePaths, readRecord, type EngineRecord } from './layout.js';
import { findJava } from './unpack.js';

/**
 * Runs the extension engine as a hidden child process of this server.
 *
 * Only the jar runs, on the downloaded Java: never Suwayomi's launcher or tray app. It
 * listens on 127.0.0.1 on a free port with a generated login, so nothing else on the
 * machine can use it. A crash is retried with a growing delay, three times, then the
 * engine is left in "error" with its last output. It stops when the server stops.
 */

export type EngineState = 'stopped' | 'starting' | 'running' | 'error';

export interface EngineRuntimeStatus {
  state: EngineState;
  /** What went wrong, when state is "error". */
  error: string | null;
  /** The engine's last lines of output, for the error. */
  lastLines: string[];
}

export interface EngineConnection {
  baseUrl: string;
  authorization: string;
}

/** How the engine is launched: the downloaded Java, or (in tests) a fake engine. */
export type Launcher = (javaArgs: string[], java: string) => { command: string; args: string[] };

const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 500;
const STOP_GRACE_MS = 10_000;
const RESTART_DELAYS_MS = [2_000, 10_000, 30_000];
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const KEPT_LINES = 40;
/** Up this long, the engine counts as recovered and its crash count starts again. */
const STABLE_AFTER_MS = 60_000;

let launcher: Launcher = (javaArgs, java) => ({ command: java, args: javaArgs });
let readyTimeoutMs = READY_TIMEOUT_MS;
let restartDelaysMs = RESTART_DELAYS_MS;

/** Test seam: launch a fake engine, with shorter waits. */
export function setEngineLauncherForTests(
  options: { launcher: Launcher; readyTimeoutMs?: number; restartDelaysMs?: number[] } | null,
): void {
  launcher = options?.launcher ?? ((javaArgs, java) => ({ command: java, args: javaArgs }));
  readyTimeoutMs = options?.readyTimeoutMs ?? READY_TIMEOUT_MS;
  restartDelaysMs = options?.restartDelaysMs ?? RESTART_DELAYS_MS;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No port')),
      );
    });
  });
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** Whether the engine answers its GraphQL with the login. */
export async function engineAnswers(connection: EngineConnection): Promise<boolean> {
  try {
    const response = await fetch(`${connection.baseUrl}${GRAPHQL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: connection.authorization },
      body: JSON.stringify({ query: '{ aboutServer { name version } }' }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: { aboutServer?: unknown } };
    return Boolean(body.data?.aboutServer);
  } catch {
    return false;
  }
}

/** The command line of a running process, or null when it can't be read. */
export type CommandLineReader = (pid: number) => Promise<string | null>;

const readCommandLine: CommandLineReader = (pid) =>
  new Promise((resolve) => {
    if (process.platform === 'linux') {
      fsp
        .readFile(`/proc/${pid}/cmdline`, 'utf8')
        .then((text) => resolve(text.split('\0').join(' ')))
        .catch(() => resolve(null));
      return;
    }
    const [command, args] =
      process.platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
          ]
        : ['ps', ['-o', 'command=', '-p', String(pid)]];
    execFile(command, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      resolve(error ? null : stdout.trim() || null),
    );
  });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface PidFile {
  pid: number;
  jar: string;
  dataDir: string;
}

/**
 * Stops an engine a hard kill left running. Only a process whose command line names both
 * this engine's jar and its data folder is stopped: a pid can be reused by anything.
 */
export async function stopStaleEngine(
  read: CommandLineReader = readCommandLine,
): Promise<'none' | 'stopped' | 'not-ours'> {
  let stale: PidFile;
  try {
    stale = JSON.parse(await fsp.readFile(enginePaths.pidFile(), 'utf8')) as PidFile;
  } catch {
    return 'none';
  }
  await fsp.rm(enginePaths.pidFile(), { force: true });
  if (!Number.isInteger(stale.pid) || stale.pid <= 0 || stale.pid === process.pid) return 'none';
  if (!isAlive(stale.pid)) return 'none';
  const commandLine = await read(stale.pid);
  const ours =
    commandLine !== null &&
    typeof stale.jar === 'string' &&
    typeof stale.dataDir === 'string' &&
    commandLine.includes(stale.jar) &&
    commandLine.includes(stale.dataDir);
  if (!ours) return 'not-ours';
  try {
    process.kill(stale.pid, 'SIGTERM');
  } catch {
    return 'none';
  }
  for (let waited = 0; waited < STOP_GRACE_MS && isAlive(stale.pid); waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (isAlive(stale.pid)) {
    try {
      process.kill(stale.pid, 'SIGKILL');
    } catch {
      // Gone meanwhile.
    }
  }
  return 'stopped';
}

/**
 * Stops the engine and anything it started (a helper process it spawned would otherwise
 * outlive it and keep its files open). Only this one engine's tree: on Windows `taskkill`
 * on its own pid with /T, elsewhere a signal to its own process group.
 */
function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL', sync = false): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // Windows has no gentle signal for a console Java process; the whole tree ends now.
    const args = ['/PID', String(pid), '/T', '/F'];
    try {
      if (sync) spawnSync('taskkill.exe', args, { windowsHide: true, timeout: 5_000 });
      else execFile('taskkill.exe', args, { windowsHide: true }, () => undefined);
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** The engine's output, appended to logs/engine.log, which rolls over at 2 MB. */
class EngineLog {
  private out: fs.WriteStream | null = null;
  private size = 0;
  private partial = '';
  readonly lines: string[] = [];

  open(): void {
    const file = enginePaths.logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
    this.out = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  }

  write(chunk: Buffer): void {
    if (!this.out) return;
    if (this.size + chunk.length > MAX_LOG_BYTES) {
      const file = enginePaths.logFile();
      this.out.end();
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        // Keep writing to the same file rather than lose output.
      }
      this.out = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
      this.size = 0;
    }
    this.out.write(chunk);
    this.size += chunk.length;
    const text = this.partial + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) if (line.trim()) this.lines.push(line);
    if (this.lines.length > KEPT_LINES) this.lines.splice(0, this.lines.length - KEPT_LINES);
  }

  close(): void {
    this.out?.end();
    this.out = null;
  }
}

class EngineProcess {
  private child: ChildProcess | null = null;
  private state: EngineState = 'stopped';
  private error: string | null = null;
  private connection: EngineConnection | null = null;
  private stopping = false;
  private crashes = 0;
  /** When the engine last came up; null while it isn't running. */
  private readyAt: number | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private log = new EngineLog();
  private readonly listeners = new Set<() => void>();

  status(): EngineRuntimeStatus {
    return { state: this.state, error: this.error, lastLines: [...this.log.lines] };
  }

  /** The address and login to reach the engine, while it runs. */
  currentConnection(): EngineConnection | null {
    return this.state === 'running' ? this.connection : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(state: EngineState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener must never break the engine.
      }
    }
  }

  /** Starts the engine; resolves once it answers (or has failed). */
  start(): Promise<void> {
    if (this.state === 'running') return Promise.resolve();
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopping = false;
    const record = readRecord();
    if (!record) {
      this.set('stopped');
      return;
    }
    this.set('starting');
    try {
      await stopStaleEngine();
      await this.spawnAndWait(record);
      this.readyAt = Date.now();
      this.set('running');
      if (record.unverified) await confirmUpdate();
    } catch (error) {
      this.kill();
      // New versions that never came up: go back to the ones that worked, once.
      if (record.unverified && (await rollBackUpdate())) {
        this.log.lines.push('The updated engine did not start; went back to the previous version.');
        return this.launch();
      }
      // A start that fails is retried like a crash, with the same limit.
      this.retryOrFail((error as Error).message);
    }
  }

  /** Schedules another start after a growing delay, or gives up with `reason`. */
  private retryOrFail(reason: string): void {
    if (this.stopping) {
      this.set('stopped');
      return;
    }
    // A run that lasted counts as recovered: only crashes in quick succession add up.
    if (this.readyAt !== null && Date.now() - this.readyAt > STABLE_AFTER_MS) this.crashes = 0;
    this.readyAt = null;
    this.crashes += 1;
    if (this.crashes > restartDelaysMs.length) {
      this.crashes = 0;
      this.set('error', reason);
      return;
    }
    this.set('starting');
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = null;
        void this.start();
      },
      restartDelaysMs[this.crashes - 1],
    );
    this.restartTimer.unref();
  }

  private async spawnAndWait(record: EngineRecord): Promise<void> {
    const java = await findJava(enginePaths.runtimeDir(record.active.runtime));
    const jar = enginePaths.serverJar(record.active.server);
    if (!java || !fs.existsSync(jar)) throw new Error('The engine files are missing');
    const dataDir = enginePaths.dataDir();
    const port = await freePort();
    const password = decryptToken(record.login.password_encrypted);
    await writeEngineConfig(dataDir, { port, username: record.login.username, password });
    const javaArgs = [
      `-Xmx${record.memoryMb}m`,
      `-D${ROOT_DIR_PROPERTY}=${dataDir}`,
      '-Djava.awt.headless=true',
      '-jar',
      jar,
    ];
    const { command, args } = launcher(javaArgs, java);
    this.log.close();
    this.log.open();
    const child = spawn(command, args, {
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group outside Windows, so stopping it reaches anything it started
      // (see killTree). On Windows the tree is found by its pid instead.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.log.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.log.write(chunk));
    let exited = false;
    child.on('exit', (code, signal) => {
      exited = true;
      this.onExit(child, code, signal);
    });
    child.on('error', (error) => {
      exited = true;
      this.log.write(Buffer.from(`${error.message}\n`));
    });
    if (child.pid) {
      await fsp.writeFile(
        enginePaths.pidFile(),
        JSON.stringify({ pid: child.pid, jar, dataDir } satisfies PidFile),
        { mode: 0o600 },
      );
    }
    this.connection = {
      baseUrl: `http://127.0.0.1:${port}`,
      authorization: basicAuth(record.login.username, password),
    };
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw new Error('The engine stopped while starting');
      if (await engineAnswers(this.connection)) return;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error("The engine didn't answer in time");
  }

  private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (child !== this.child) return;
    this.child = null;
    void fsp.rm(enginePaths.pidFile(), { force: true });
    // While starting, the start itself sees the exit and retries.
    if (this.stopping || this.state !== 'running') return;
    this.connection = null;
    this.retryOrFail(
      `The engine stopped unexpectedly (${signal ?? `exit code ${code}`}), and kept stopping`,
    );
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.connection = null;
    if (child && child.exitCode === null) killTree(child, 'SIGKILL');
    void fsp.rm(enginePaths.pidFile(), { force: true });
  }

  /** Stops the engine: gently, then forcefully after a grace period. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.starting?.catch(() => undefined);
    const child = this.child;
    this.connection = null;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      killTree(child, 'SIGTERM');
      const grace = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), STOP_GRACE_MS).unref(),
      );
      if ((await Promise.race([exited, grace])) === 'timeout') {
        killTree(child, 'SIGKILL');
        await exited;
      }
    }
    this.child = null;
    await fsp.rm(enginePaths.pidFile(), { force: true });
    this.log.close();
    this.crashes = 0;
    this.set('stopped');
  }

  /** Synchronous last resort for process exit: no waiting is possible there. */
  killNow(): void {
    this.stopping = true;
    if (this.child && this.child.exitCode === null) killTree(this.child, 'SIGKILL', true);
    try {
      fs.rmSync(enginePaths.pidFile(), { force: true });
    } catch {
      // Exiting anyway.
    }
  }
}

export const engineProcess = new EngineProcess();
