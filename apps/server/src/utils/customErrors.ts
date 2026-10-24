export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode = 500, name = 'AppError') {
    super(message);
    this.name = name;
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class MangaFetchError extends AppError {
  constructor(message = 'Failed to fetch manga data') {
    super(message, 500, 'MangaFetchError');
  }
}

export class MangaNotFoundError extends AppError {
  constructor(message = 'Manga not found') {
    super(message, 404, 'MangaNotFoundError');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request') {
    super(message, 400, 'ValidationError');
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request payload is too large') {
    super(message, 413, 'PayloadTooLargeError');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NotFoundError');
  }
}

export class DuplicateResourceError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'DuplicateResourceError');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Not authenticated') {
    super(message, 401, 'UnauthorizedError');
  }
}

export class PrismaError extends AppError {
  constructor(message = 'Database operation failed', statusCode = 500) {
    super(message, statusCode, 'PrismaError');
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable') {
    super(message, 503, 'ServiceUnavailableError');
  }
}

export class TimeoutError extends AppError {
  constructor(message = 'Request timeout') {
    super(message, 504, 'TimeoutError');
  }
}

/** A manga source returned something unusable — an error response, or HTML/JSON that
 * doesn't match what the scraper/client expects (the site likely changed its layout). */
export class UpstreamError extends AppError {
  constructor(message = 'The source returned an unexpected response') {
    super(message, 502, 'UpstreamError');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'This request is not allowed') {
    super(message, 403, 'ForbiddenError');
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Request bodies must be JSON') {
    super(message, 415, 'UnsupportedMediaTypeError');
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests — please wait and try again') {
    super(message, 429, 'RateLimitedError');
  }
}

/**
 * Rethrows known AppError subclasses as-is (so their status code reaches the client
 * unchanged) and wraps anything else with the given fallback error.
 */
export function rethrowKnownOrWrap(error: unknown, fallback: AppError): never {
  if (error instanceof AppError) {
    throw error;
  }
  throw fallback;
}
