import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const { getSessionUser, touchLastSeen } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  touchLastSeen: vi.fn(async () => undefined),
}));
vi.mock('../src/services/auth.service.js', () => ({
  default: { getSessionUser },
  SESSION_COOKIE_NAME: 'pm_session',
  SESSION_TTL_MS: 90 * 24 * 60 * 60 * 1000,
}));
vi.mock('../src/repositories/session.repository.js', () => ({ default: { touchLastSeen } }));

const { attachUser } = await import('../src/middleware/auth.middleware.js');

const DAY = 24 * 60 * 60 * 1000;

function run(session: { last_seen_at: Date; expires_at: Date }) {
  getSessionUser.mockResolvedValueOnce({
    user: { id: 'user-1' },
    session: { id: 'sess-1', ...session },
  });
  const req = { cookies: { pm_session: 'token' } } as unknown as Request;
  const res = { cookie: vi.fn() } as unknown as Response & { cookie: ReturnType<typeof vi.fn> };
  const next = vi.fn() as NextFunction;
  return attachUser(req, res, next).then(() => ({ req, res, next }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attachUser', () => {
  it('skips the last-seen write when the session was seen moments ago', async () => {
    const { req, next } = await run({
      last_seen_at: new Date(Date.now() - 1000),
      expires_at: new Date(Date.now() + 80 * DAY),
    });
    expect(req.user).toEqual({ id: 'user-1' });
    expect(next).toHaveBeenCalledOnce();
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it('records activity without renewing a session early in its life', async () => {
    const { res } = await run({
      last_seen_at: new Date(Date.now() - 10 * 60 * 1000),
      expires_at: new Date(Date.now() + 80 * DAY),
    });
    expect(touchLastSeen).toHaveBeenCalledWith('sess-1', undefined);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('renews a session used in the second half of its lifetime', async () => {
    const { res } = await run({
      last_seen_at: new Date(Date.now() - 10 * 60 * 1000),
      expires_at: new Date(Date.now() + 10 * DAY),
    });
    const [, expiresAt] = touchLastSeen.mock.calls[0] as unknown as [string, Date];
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 89 * DAY);
    expect(res.cookie).toHaveBeenCalledWith('pm_session', 'token', expect.any(Object));
  });
});
