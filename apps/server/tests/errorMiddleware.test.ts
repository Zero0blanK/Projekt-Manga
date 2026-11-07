import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import errorHandler from '../src/middleware/error.middleware.js';
import { resetDiagnosticEventsForTests } from '../src/utils/diagnosticLog.js';
import { PrismaError, rethrowKnownOrWrap } from '../src/utils/customErrors.js';

afterEach(resetDiagnosticEventsForTests);

describe('errorHandler', () => {
  it('delegates an error after response streaming has begun', () => {
    const error = new Error('stream failed');
    const next = vi.fn<NextFunction>();
    const response = { headersSent: true } as Response;

    errorHandler(error, {} as Request, response, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  it('logs only safe codes and correlation IDs for unexpected errors', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    try {
      errorHandler(
        new Error('https://example.test/chapter?token=secret in C:\\Users\\person\\private'),
        {} as Request,
        response,
        vi.fn<NextFunction>(),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|example\.test|Users|private/);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('api.unhandled_error'));
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['P2002', 409],
    ['P2003', 400],
    ['P2025', 404],
  ])('maps Prisma %s to %i', (code, status) => {
    const response = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    errorHandler(
      Object.assign(new Error('prisma'), { code }),
      {} as Request,
      response,
      vi.fn<NextFunction>(),
    );

    expect(response.status).toHaveBeenCalledWith(status);
  });

  it('reports an unmapped Prisma code as a database error', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    try {
      errorHandler(
        Object.assign(new Error('prisma'), { code: 'P2034' }),
        {} as Request,
        response,
        vi.fn<NextFunction>(),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"code":"DATABASE_ERROR"'));
      expect(response.status).toHaveBeenCalledWith(500);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the request-shaped Prisma failures through rethrowKnownOrWrap', () => {
    const duplicate = Object.assign(new Error('prisma'), { code: 'P2002' });
    const fallback = new PrismaError('Could not save');

    expect(() => rethrowKnownOrWrap(duplicate, fallback)).toThrow(duplicate);
    expect(() => rethrowKnownOrWrap(new Error('other'), fallback)).toThrow(fallback);
  });

  it('reports a Node network error code as an internal error, not a database one', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    try {
      errorHandler(
        Object.assign(new Error('write EPROTO'), { code: 'EPROTO' }),
        {} as Request,
        response,
        vi.fn<NextFunction>(),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"code":"INTERNAL_ERROR"'));
      expect(response.status).toHaveBeenCalledWith(500);
    } finally {
      log.mockRestore();
    }
  });
});
