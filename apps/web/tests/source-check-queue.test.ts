import { beforeEach, describe, expect, it, vi } from 'vitest';

type State = { status: 'passed' | 'failed'; at: number; message: string };

const checks = vi.hoisted(() => ({
  started: [] as string[],
  finish: new Map<string, (state: State) => void>(),
  running: new Map<string, Promise<State>>(),
}));

const api = vi.hoisted(() => ({
  sessions: {} as Record<string, { cookies: { name: string; expires: number | null }[] }>,
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getSources: async () => [
    { id: 'expired', provider: 'extension' },
    { id: 'current', provider: 'extension' },
    { id: 'blocked', provider: 'extension' },
    { id: 'never', provider: 'extension' },
    { id: 'suwa', provider: 'suwayomi' },
  ],
  getSourceHealth: async () => [],
  getSourceBrowserSession: async (id: string) =>
    api.sessions[id] ?? { cookies: [] as { name: string; expires: number | null }[] },
}));
vi.mock('@/lib/app-store', () => ({ getSetting: () => true }));
vi.mock('@/lib/source-check', () => ({
  canCheckSources: () => true,
  getSourceCheck: () => ({ status: 'idle' }),
  runningSourceCheck: (id: string) => checks.running.get(id) ?? null,
  startSourceCheck: (id: string) => {
    checks.started.push(id);
    const run = new Promise<State>((resolve) =>
      checks.finish.set(id, (state) => {
        checks.running.delete(id);
        resolve(state);
      }),
    );
    checks.running.set(id, run);
    return run;
  },
}));

const {
  beforeCheckingSource,
  checkSourcesOnStartup,
  clearanceRunningOut,
  passCheckForUpdate,
  queueSourceCheck,
  resetSourceCheckQueue,
  sourcesNeedingCheck,
} = await import('@/lib/source-check-queue');

const pass = (id: string) => checks.finish.get(id)!({ status: 'passed', at: 0, message: '' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetSourceCheckQueue();
  checks.started.length = 0;
  checks.finish.clear();
  checks.running.clear();
});

describe('background browser checks', () => {
  it('renews a clearance that has run out or is about to, and only one with a clearance', () => {
    const now = Date.UTC(2026, 10, 14);
    const inMinutes = (m: number) => Math.floor((now + m * 60_000) / 1000);
    expect(clearanceRunningOut([{ name: 'cf_clearance', expires: inMinutes(-5) }], now)).toBe(true);
    expect(clearanceRunningOut([{ name: 'cf_clearance', expires: inMinutes(20) }], now)).toBe(true);
    expect(clearanceRunningOut([{ name: 'cf_clearance', expires: inMinutes(600) }], now)).toBe(
      false,
    );
    expect(clearanceRunningOut([{ name: 'session', expires: inMinutes(-5) }], now)).toBe(false);
  });

  it('finds at start-up the sources whose clearance ran out or no longer lets the app in', async () => {
    const seconds = (ms: number) => Math.floor(ms / 1000);
    api.sessions = {
      expired: { cookies: [{ name: 'cf_clearance', expires: seconds(Date.now() - 60_000) }] },
      current: { cookies: [{ name: 'cf_clearance', expires: seconds(Date.now() + 86_400_000) }] },
      blocked: { cookies: [{ name: 'cf_clearance', expires: seconds(Date.now() + 86_400_000) }] },
    };
    const probe = vi.fn(async (id: string) => id === 'blocked');
    await expect(sourcesNeedingCheck(probe)).resolves.toEqual(['expired', 'blocked']);
    // Asked only of sources that have needed a check, and not of one already known.
    expect(probe.mock.calls.map(([id]) => id)).toEqual(['current', 'blocked']);
  });

  it('passes the checks start-up finds one at a time', async () => {
    await checkSourcesOnStartup(undefined, async () => ['a', 'b']);
    await tick();
    expect(checks.started).toEqual(['a']);
    pass('a');
    await tick();
    expect(checks.started).toEqual(['a', 'b']);
  });

  it('puts the source a library update has reached first, and waits for it', async () => {
    await checkSourcesOnStartup(undefined, async () => ['a', 'b', 'c']);
    await tick();
    const waiting = beforeCheckingSource('c');
    expect(waiting).not.toBeNull();
    pass('a');
    await tick();
    expect(checks.started).toEqual(['a', 'c']);
    pass('c');
    await expect(waiting).resolves.toMatchObject({ status: 'passed' });
  });

  it('lets a source with nothing queued start at once', () => {
    expect(beforeCheckingSource('quiet')).toBeNull();
  });

  it('runs a check met mid-update and says to try the title again once it passes', async () => {
    const retry = passCheckForUpdate('late');
    await tick();
    expect(checks.started).toEqual(['late']);
    pass('late');
    await expect(retry).resolves.toBe(true);
  });

  it('joins a running check instead of starting another', async () => {
    const first = queueSourceCheck('a');
    await tick();
    const second = queueSourceCheck('a');
    pass('a');
    await Promise.all([first, second]);
    expect(checks.started).toEqual(['a']);
  });

  it('hands every request for the running check the same promise, so it is announced once', async () => {
    const first = queueSourceCheck('a');
    await tick();
    expect(queueSourceCheck('a')).toBe(first);
    pass('a');
    await first;
  });
});
