import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/customErrors.js';

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Guards routes that act on the host rather than on an account: the download folder,
 * installing extension code, restoring a backup.
 *
 * Opt-in: with no `ADMIN_TOKEN` configured every client passes, so a self-hosted server can
 * be managed from any browser out of the box. Once a token is set, admission is by origin —
 * anonymous use means there is no user to check — so loopback clients (the desktop app, the
 * local web server) pass and anyone else must send the token. `req.ip` honours TRUST_PROXY,
 * so behind a proxy this is the forwarded client address, not the proxy's. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || LOOPBACK.test(req.ip ?? '')) return next();

  const header = req.headers['x-admin-token'];
  if (tokenMatches(Array.isArray(header) ? header[0] : header, expected)) {
    return next();
  }
  return next(new ForbiddenError('This action is only available from the server host'));
}
