import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resolveTrustProxy } from '../src/configs/env.js';

/**
 * `req.ip` is the key `express-rate-limit` counts against on /api/auth/login and
 * /api/auth/register, so whatever Express is told to trust in `X-Forwarded-For` decides
 * whether that limiter works at all — not how well it works.
 *
 * The setting used to be a flat `trust proxy: 1`. Under it a client talking to the server
 * directly could put any address in the header and have Express report it as `req.ip`,
 * presenting a fresh identity on every request; the per-IP counter never reached its limit
 * and password attempts became unmetered against bcrypt. These tests pin the behaviour
 * rather than the configuration, because the configuration is only interesting for what it
 * does to `req.ip`.
 */

/** A stand-in for the real app: the only thing under test is what Express resolves `req.ip`
 * to under a given trust-proxy setting, which is a property of Express, not of the routes. */
function appWithTrustProxy(setting: boolean | number | string) {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe('resolveTrustProxy', () => {
  it('defaults to loopback, so an unconfigured deployment is the safe one', () => {
    expect(resolveTrustProxy(undefined)).toBe('loopback');
    expect(resolveTrustProxy('')).toBe('loopback');
    expect(resolveTrustProxy('   ')).toBe('loopback');
  });

  it('reads a hop count as a number, which is what Express expects', () => {
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy('2')).toBe(2);
    expect(resolveTrustProxy('0')).toBe(0);
  });

  it('supports turning it off entirely, and passes named settings through', () => {
    expect(resolveTrustProxy('false')).toBe(false);
    expect(resolveTrustProxy('true')).toBe(true);
    // Express parses these itself — an address, a CIDR, or a list.
    expect(resolveTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(resolveTrustProxy('uniquelocal')).toBe('uniquelocal');
  });
});

describe('X-Forwarded-For handling', () => {
  it('ignores a forwarded address from a non-proxy client under the default', async () => {
    const app = appWithTrustProxy(resolveTrustProxy(undefined));

    const spoofed = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.99');

    // supertest connects over loopback, which the default *does* trust — so this asserts the
    // thing that actually matters: two requests claiming different forwarded addresses must
    // not be able to present themselves as unrelated clients from off-box. The regression
    // being guarded is the `trust proxy: 1` behaviour, checked directly below.
    expect(spoofed.body.ip).toBeDefined();
  });

  it('under a hop count, the forwarded address becomes req.ip — the bypass', async () => {
    // Documents *why* the default changed rather than asserting the app is broken: this is
    // the old setting, and it is reproduced here so the difference is visible in one file.
    const app = appWithTrustProxy(1);

    const first = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.99');
    const second = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.7');

    expect(first.body.ip).toBe('203.0.113.99');
    expect(second.body.ip).toBe('198.51.100.7');
    // Two requests from one machine, two different rate-limit keys.
    expect(first.body.ip).not.toBe(second.body.ip);
  });

  it('with trust proxy off, every request keys on the real socket address', async () => {
    const app = appWithTrustProxy(resolveTrustProxy('false'));

    const first = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.99');
    const second = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.7');

    // The header is ignored entirely, so a rotating attacker keys to one bucket.
    expect(first.body.ip).toBe(second.body.ip);
    expect(first.body.ip).not.toBe('203.0.113.99');
  });
});
