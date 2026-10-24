import type { Response } from 'express';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../services/auth.service.js';

/** Sets (or renews) the session cookie for the full session lifetime. */
export function writeSessionCookie(res: Response, sessionToken: string) {
  res.cookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}
