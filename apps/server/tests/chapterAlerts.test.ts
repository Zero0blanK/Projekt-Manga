import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { alertText, requestFor } from '../src/services/notificationChannel.service.js';

const titles = [
  { title: 'Frieren', count: 2 },
  { title: 'Dandadan', count: 1 },
];

describe('chapter alert messages', () => {
  it('sums the chapters and lists the titles', () => {
    expect(alertText(titles)).toEqual({
      title: '3 new chapters',
      body: '• Frieren: 2 new\n• Dandadan: 1 new',
    });
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, count: 1 }));
    expect(alertText(many).body.split('\n').at(-1)).toBe('and 2 more titles');
  });

  it('formats each service the way it expects', () => {
    const message = alertText(titles);
    const ntfy = requestFor('ntfy', { url: 'https://ntfy.sh/mine', token: 'tk' }, message, titles);
    expect(ntfy.url.href).toBe('https://ntfy.sh/mine');
    expect(ntfy.init.headers).toMatchObject({
      Title: '3 new chapters',
      Authorization: 'Bearer tk',
    });

    const discord = requestFor(
      'discord',
      { url: 'https://discord.com/api/webhooks/1/abc' },
      message,
      titles,
    );
    const discordBody = JSON.parse(discord.init.body as string);
    expect(discordBody.content).toContain('**3 new chapters**');
    // A title containing "@everyone" must not ping anyone.
    expect(discordBody.allowed_mentions).toEqual({ parse: [] });

    const telegram = requestFor('telegram', { token: '123:abc', chat_id: '-100' }, message, titles);
    expect(telegram.url.href).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(telegram.init.body as string).chat_id).toBe('-100');

    const webhook = requestFor('webhook', { url: 'https://example.com/hook' }, message, titles);
    expect(JSON.parse(webhook.init.body as string)).toMatchObject({
      event: 'new-chapters',
      titles,
    });
  });
});

describe('alert channel validation', () => {
  it.each([
    [
      { kind: 'discord', name: 'D', url: 'https://example.com/api/webhooks/1/x' },
      'Discord webhook',
    ],
    [{ kind: 'telegram', name: 'T', token: 'nope', chat_id: '1' }, 'Telegram bot token'],
    [{ kind: 'webhook', name: 'W', url: 'ftp://example.com/hook' }, 'http(s)'],
    [{ kind: 'webhook', name: 'W', url: 'https://user:pass@example.com/' }, 'token field'],
    [{ kind: 'carrier-pigeon', name: 'P', url: 'https://example.com' }, ''],
  ])('refuses %o', async (body, message) => {
    const res = await request(app).post('/api/notification-channels').send(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(message);
  });

  it('refuses an empty or oversized alert', async () => {
    for (const body of [
      { titles: [] },
      { titles: [{ title: '', count: 1 }] },
      { titles: Array.from({ length: 201 }, () => ({ title: 'x', count: 1 })) },
    ])
      expect((await request(app).post('/api/notification-channels/alert').send(body)).status).toBe(
        400,
      );
  });
});
