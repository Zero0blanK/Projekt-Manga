import { Request, Response, NextFunction } from 'express';
import { HTTPErrorResponse } from '../utils/responseHandlers.js';
import { AppError } from '../utils/customErrors.js';
import { currentRequestId } from '../utils/requestContext.js';
import { recordDiagnosticEvent } from '../utils/diagnosticLog.js';

interface PrismaLikeError {
  code: string;
}

function isPrismaLikeError(err: unknown): err is PrismaLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

/** An `http-errors`-shaped error, as thrown by body-parser before any route runs. */
interface HttpLikeError {
  statusCode: number;
  type?: string;
}

function isHttpLikeError(err: unknown): err is HttpLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number'
  );
}

/**
 * Body-parser's own failure types, mapped to messages safe to return as-is. The raw
 * errors carry parser internals (byte offsets, the rejected body) that shouldn't reach
 * the client, so only the type is used — never the original message.
 */
const REQUEST_ERROR_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'Malformed JSON in request body',
  'entity.verify.failed': 'Request body failed verification',
  'entity.too.large': 'Request body is too large',
  'request.aborted': 'Request aborted before it was fully received',
  'request.size.invalid': 'Request body size did not match Content-Length',
  'parameters.too.many': 'Too many parameters in request body',
  'charset.unsupported': 'Unsupported charset in request body',
  'encoding.unsupported': 'Unsupported content encoding in request body',
};

export default function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Streaming handlers (notably downloaded page files) can fail after their status and
  // headers reached the client. A JSON response at that point would itself throw
  // ERR_HTTP_HEADERS_SENT; Express's default handler can close the interrupted stream.
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    return HTTPErrorResponse(res, err.statusCode, err.message);
  }

  if (isPrismaLikeError(err)) {
    if (err.code === 'P2002') {
      return HTTPErrorResponse(res, 409, 'Unique constraint violation');
    }
    if (err.code === 'P2003') {
      return HTTPErrorResponse(res, 400, 'Foreign key constraint violation');
    }
    if (err.code === 'P2025') {
      return HTTPErrorResponse(res, 404, 'Record not found');
    }
  }

  // Transport-level errors raised while reading the request itself (malformed JSON,
  // oversized or mis-encoded bodies). These are the caller's fault, so they keep their
  // own 4xx status rather than being reported as a server failure — and they're not
  // logged as unhandled, since a bad client payload isn't a fault on this side.
  if (isHttpLikeError(err) && err.statusCode >= 400 && err.statusCode < 500) {
    const message = (err.type && REQUEST_ERROR_MESSAGES[err.type]) || 'Invalid request';
    return HTTPErrorResponse(res, err.statusCode, message);
  }

  // Fallback: never leak internal error details to the client.
  const requestId = currentRequestId();
  recordDiagnosticEvent({
    level: 'error',
    area: 'api',
    event: 'api.unhandled_error',
    requestId,
    code: isPrismaLikeError(err) ? 'DATABASE_ERROR' : 'INTERNAL_ERROR',
  });
  // Keep process logs useful for operators without serialising Axios config, response
  // bodies, signed query parameters, or personal paths into stdout.
  console.error(
    JSON.stringify({
      level: 'error',
      area: 'api',
      event: 'api.unhandled_error',
      requestId: requestId ?? null,
      code: isPrismaLikeError(err) ? 'DATABASE_ERROR' : 'INTERNAL_ERROR',
    }),
  );
  // In development the bare code above says nothing about *which* query failed; the local
  // developer is the operator there, so the underlying error is printed too.
  if (process.env.NODE_ENV === 'development') {
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
  }
  return HTTPErrorResponse(res, 500, 'Internal server error');
}
