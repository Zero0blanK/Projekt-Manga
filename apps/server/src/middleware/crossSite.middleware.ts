import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnsupportedMediaTypeError } from '../utils/customErrors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Refuses state-changing requests that another website could make on the reader's behalf.
 *
 * CORS does not stop these: an HTML form can POST cross-site with no preflight, and
 * anonymous use needs no session cookie, so SameSite=Lax protects nothing there. Two
 * rules close it:
 *
 * - **Bodies must be JSON.** A form can only send urlencoded, multipart or text/plain;
 *   it cannot set `application/json`. Requests without a body (most action endpoints)
 *   carry no Content-Type and pass.
 * - **The request must come from this app.** Browsers send `Sec-Fetch-Site`; `cross-site`
 *   is refused, while `same-origin` (the desktop's single-origin proxy) and `same-site`
 *   (web :3000 → API :4000 in development) pass. Older browsers without it fall back to
 *   comparing `Origin` with CLIENT_URL or this request's own host. Requests without
 *   either header come from non-browser clients (the desktop main process, scripts) and
 *   pass, since no website can make them.
 */
export default function rejectCrossSiteWrites(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const contentType = req.get('content-type');
  if (contentType && !req.is('application/json')) {
    return next(new UnsupportedMediaTypeError());
  }

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite) {
    return fetchSite === 'cross-site'
      ? next(new ForbiddenError('Requests from other websites are not allowed'))
      : next();
  }

  const origin = req.get('origin');
  if (!origin) return next();
  const allowed = new Set(
    [
      originOf(process.env.CLIENT_URL || 'http://localhost:3000'),
      originOf(`${req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`),
    ].filter((value): value is string => value !== null),
  );
  return allowed.has(origin)
    ? next()
    : next(new ForbiddenError('Requests from other websites are not allowed'));
}
