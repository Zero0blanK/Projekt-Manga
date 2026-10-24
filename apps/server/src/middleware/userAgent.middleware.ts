import { NextFunction, Request, Response } from 'express';
import { setBrowserUserAgent } from '../utils/userAgent.js';

// Overwrites the single process-wide browserUserAgent (see getServerUserAgent) from
// whichever request happened to arrive most recently — any visitor, unauthenticated,
// could be a bot. That's accepted: a real client's UA reads more like an ordinary browser
// to sources than the static/remote fallback, and this is best-effort, not per-request state.
export default function captureUserAgent(req: Request, _res: Response, next: NextFunction) {
  const userAgent = req.headers['user-agent'];
  if (typeof userAgent === 'string' && userAgent.trim().length > 0) {
    setBrowserUserAgent(userAgent);
  }

  next();
}
