import { Request, Response, NextFunction } from 'express';
import authService, { SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../services/auth.service.js';
import { writeSessionCookie } from '../utils/sessionCookie.js';
import sessionRepository from '../repositories/session.repository.js';
import { UnauthorizedError } from '../utils/customErrors.js';
import type { user as User } from '@prisma/client';

declare global {
  // Express's own types are declared in a global `namespace`, so augmenting Request means
  // re-opening that namespace — there is no ES-module equivalent to do it any other way.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      /** The stored session id (a hash of the cookie token), never the token itself. */
      sessionId?: string;
    }
  }
}

/** How stale a session's last-seen time may get before a request refreshes it. */
export const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

/** Non-blocking: attaches req.user/req.sessionId when a valid session cookie is present,
 * otherwise leaves them undefined and lets the request through unauthenticated. Mounted
 * globally so every route can optionally read req.user without needing its own guard —
 * routes that must reject anonymous requests use requireAuth in addition to this. */
export async function attachUser(req: Request, res: Response, next: NextFunction) {
  const sessionToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  const result = await authService.getSessionUser(sessionToken);

  if (result) {
    req.user = result.user;
    // The stored (hashed) id, not the raw cookie value — nothing downstream needs the
    // bearer token itself, so it stops here rather than travelling through the request.
    req.sessionId = result.session.id;
    // Fire-and-forget so requests don't wait on the write, and a failure (e.g. a concurrent
    // logout deleted the session) doesn't fail them. Throttled to LAST_SEEN_INTERVAL_MS:
    // a reader page view is dozens of image requests, and a write for each competes with
    // the download worker for SQLite's single writer.
    const lastSeen = result.session.last_seen_at?.getTime() ?? 0;
    if (Date.now() - lastSeen < LAST_SEEN_INTERVAL_MS) {
      next();
      return;
    }
    // Sliding expiry: a session used in the second half of its lifetime is renewed for a
    // full one, so someone who reads every week isn't signed out on day 90.
    const renew =
      sessionToken && result.session.expires_at.getTime() - Date.now() < SESSION_TTL_MS / 2;
    if (renew) writeSessionCookie(res, sessionToken);
    const expiresAt = renew ? new Date(Date.now() + SESSION_TTL_MS) : undefined;
    sessionRepository.touchLastSeen(result.session.id, expiresAt).catch((error: unknown) => {
      // Best-effort, but logged so a stale last-seen time can be diagnosed.
      console.warn('[auth] Could not update session last-seen timestamp:', error);
    });
  }

  next();
}

/** Route guard for endpoints that require a logged-in user — mount after attachUser. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new UnauthorizedError());
  }
  next();
}
