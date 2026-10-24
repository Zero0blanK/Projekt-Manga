import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { withRequestId } from '../utils/requestContext.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get('x-request-id');
  const id = supplied && UUID.test(supplied) ? supplied : randomUUID();
  res.setHeader('X-Request-Id', id);
  withRequestId(id, next);
}
