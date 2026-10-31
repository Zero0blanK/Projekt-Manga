import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/configs/prisma.config.js';
import { resetAlertRateLimit } from '../../src/services/notificationChannel.service.js';

// A local stand-in for a webhook receiver: never a real Discord, Telegram or ntfy.
const received: Array<{ path: string; body: unknown }> = [];
let receiver: http.Server;
let base = '';

const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

beforeAll(async () => {
  // Destinations are encrypted with the tracker-token key; a throwaway one for this file.
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(req.url === '/broken' ? 500 : 200).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});
afterEach(() => {
  delete process.env.ALERTS_ALLOW_PRIVATE_HOSTS;
  received.length = 0;
  resetAlertRateLimit();
});

const addWebhook = (url: string, name = 'Hook') =>
  request(app).post('/api/notification-channels').send({ kind: 'webhook', name, url });

describe('chapter alerts (real SQLite, local receiver)', () => {
  it('stores the destination encrypted and never returns it', async () => {
    const created = await addWebhook(`${base}/secret-path?token=abc`);
    expect(created.status).toBe(201);
    expect(created.body.data.destination).toBe(new URL(base).host);
    const listed = await request(app).get('/api/notification-channels');
    expect(JSON.stringify(listed.body)).not.toContain('secret-path');
    const row = await prisma.notification_channel.findFirstOrThrow();
    expect(row.target_encrypted).not.toContain('secret-path');
  });

  it('refuses a private address unless the server allows it', async () => {
    const created = await addWebhook(`${base}/hook`);
    const tested = await request(app).post(
      `/api/notification-channels/${created.body.data.id}/test`,
    );
    expect(tested.body.data.last_error).toMatch(/not a public address/);
    expect(received).toHaveLength(0);

    process.env.ALERTS_ALLOW_PRIVATE_HOSTS = 'true';
    const retried = await request(app).post(
      `/api/notification-channels/${created.body.data.id}/test`,
    );
    expect(retried.body.data.last_error).toBeNull();
    expect(received[0].path).toBe('/hook');
  });

  it('sends one message per update to each enabled channel, and records failures safely', async () => {
    process.env.ALERTS_ALLOW_PRIVATE_HOSTS = 'true';
    await addWebhook(`${base}/one`, 'One');
    const broken = await addWebhook(`${base}/broken`, 'Broken');
    const off = await addWebhook(`${base}/off`, 'Off');
    await request(app)
      .patch(`/api/notification-channels/${off.body.data.id}`)
      .send({ enabled: false });

    const titles = [{ title: 'Frieren', count: 2 }];
    const sent = await request(app).post('/api/notification-channels/alert').send({ titles });
    expect(sent.body.data).toEqual({ sent: 1, skipped: false });
    expect(received.map((entry) => entry.path).sort()).toEqual(['/broken', '/one']);
    expect(received.find((entry) => entry.path === '/one')?.body).toMatchObject({
      event: 'new-chapters',
      title: '2 new chapters',
      titles,
    });
    const brokenRow = await prisma.notification_channel.findUniqueOrThrow({
      where: { id: broken.body.data.id },
    });
    expect(brokenRow.last_error).toBe('HTTP 500');

    // A second alert straight after is skipped: one per update run.
    const again = await request(app).post('/api/notification-channels/alert').send({ titles });
    expect(again.body.data).toEqual({ sent: 0, skipped: true });
  });

  it("keeps an account's channels to itself", async () => {
    const user = await prisma.user.create({
      data: { email: 'alerts-owner@example.com', password_hash: 'x' },
    });
    await prisma.notification_channel.create({
      data: { user_id: user.id, kind: 'webhook', name: 'Theirs', target_encrypted: 'x' },
    });
    expect((await request(app).get('/api/notification-channels')).body.data).toEqual([]);
  });
});
