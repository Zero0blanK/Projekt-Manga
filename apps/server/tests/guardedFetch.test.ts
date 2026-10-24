import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Simulates DNS rebinding for one made-up host: the pre-flight check (dns/promises) sees a
// public address, the connect-time lookup (callback dns) gets loopback.
vi.mock('dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dns')>();
  const lookup = ((hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    if (hostname !== 'rebind.test') return actual.lookup(hostname, options as never, cb as never);
    const all = typeof options === 'object' && (options as { all?: boolean }).all;
    return all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  }) as typeof actual.lookup;
  return { ...actual, default: { ...actual, lookup }, lookup };
});
vi.mock('dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dns/promises')>();
  const lookup = (async (hostname: string, options?: unknown) =>
    hostname === 'rebind.test'
      ? [{ address: '93.184.216.34', family: 4 }]
      : actual.lookup(hostname, options as never)) as typeof actual.lookup;
  return { ...actual, default: { ...actual, lookup }, lookup };
});

const { assertPublicHttpUrl } = await import('../src/utils/ssrfGuard.js');
const { guardedFetch } = await import('../src/utils/guardedFetch.js');

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('internal secret'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('guardedFetch', () => {
  it('refuses a host that passed the pre-flight check but resolves to loopback at connect time', async () => {
    const url = `http://rebind.test:${port}/`;
    await expect(assertPublicHttpUrl(url)).resolves.toBeInstanceOf(URL);
    await expect(guardedFetch(new URL(url), {})).rejects.toMatchObject({
      cause: { message: expect.stringContaining('Refusing to connect to rebind.test (127.0.0.1)') },
    });
  });

  it('refuses loopback by name even without any pre-flight check', async () => {
    // The unguarded global fetch reaches the same server, which is what the sandbox used to do.
    expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('internal secret');
    await expect(guardedFetch(new URL(`http://localhost:${port}/`), {})).rejects.toMatchObject({
      cause: { message: expect.stringContaining('Refusing to connect to localhost') },
    });
  });
});
