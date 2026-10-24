import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../src/middleware/admin.middleware.js';

function run(ip: string | undefined, token?: string) {
  const req = { ip, headers: token === undefined ? {} : { 'x-admin-token': token } } as Request;
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  requireAdmin(req, {} as Response, next);
  return next;
}

afterEach(() => {
  delete process.env.ADMIN_TOKEN;
});

describe('requireAdmin', () => {
  it('admits every client when no ADMIN_TOKEN is configured', () => {
    expect(run('203.0.113.9')).toHaveBeenCalledWith();
    expect(run('203.0.113.9', 'anything-at-all-16chars')).toHaveBeenCalledWith();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'admits loopback client %s without a token when one is configured',
    (ip) => {
      process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
      expect(run(ip)).toHaveBeenCalledWith();
    },
  );

  it('rejects a remote client with no token when one is configured', () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    const next = run('203.0.113.9');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('admits a remote client with the configured token and rejects a wrong one', () => {
    process.env.ADMIN_TOKEN = 'a-sixteen-char-token';
    expect(run('203.0.113.9', 'a-sixteen-char-token')).toHaveBeenCalledWith();
    expect(run('203.0.113.9', 'a-sixteen-char-wrong')).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(run('203.0.113.9', 'short')).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});
