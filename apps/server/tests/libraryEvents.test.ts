import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import libraryEvents, {
  announceLibraryWrites,
  closeAllLibraryEventStreams,
} from '../src/routes/libraryEvents.route.js';

let server: Server;

/** A library write route and the event stream, with the user taken from a test header. */
async function start() {
  const app = express();
  app.use((req, _res, next) => {
    const id = req.header('x-test-user');
    if (id) (req as unknown as { user: { id: string } }).user = { id };
    next();
  });
  app.use(announceLibraryWrites);
  app.post('/api/history', (_req, res) => res.status(201).json({ ok: true }));
  app.post('/api/history/fail', (_req, res) => res.status(400).json({ ok: false }));
  app.post('/api/source/x', (_req, res) => res.json({ ok: true }));
  app.use('/api/library-events', libraryEvents);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Opens a stream and collects its event names. */
async function listen(base: string, user?: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/library-events/stream`, {
    headers: user ? { 'x-test-user': user } : {},
    signal: controller.signal,
  });
  const events: string[] = [];
  const reader = response.body!.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const match of decoder.decode(value).matchAll(/^event: (\w+)$/gm))
          events.push(match[1]);
      }
    } catch {
      // aborted
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { events, close: () => controller.abort() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

afterEach(async () => {
  closeAllLibraryEventStreams();
  await new Promise((resolve) => server.close(resolve));
});

describe('library change events', () => {
  it("tells the same library's streams about a successful library write, once per burst", async () => {
    const base = await start();
    const mine = await listen(base, 'u1');
    const other = await listen(base, 'u2');
    const anonymous = await listen(base);
    await fetch(`${base}/api/history`, { method: 'POST', headers: { 'x-test-user': 'u1' } });
    await fetch(`${base}/api/history`, { method: 'POST', headers: { 'x-test-user': 'u1' } });
    await settle();
    expect(mine.events).toEqual(['connected', 'change']);
    expect(other.events).toEqual(['connected']);
    expect(anonymous.events).toEqual(['connected']);
    [mine, other, anonymous].forEach((stream) => stream.close());
  });

  it('ignores failed writes and writes outside library data', async () => {
    const base = await start();
    const stream = await listen(base);
    await fetch(`${base}/api/history/fail`, { method: 'POST' });
    await fetch(`${base}/api/source/x`, { method: 'POST' });
    await settle();
    expect(stream.events).toEqual(['connected']);
    await fetch(`${base}/api/history`, { method: 'POST' });
    await settle();
    expect(stream.events).toEqual(['connected', 'change']);
    stream.close();
  });
});
