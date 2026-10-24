import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import errorHandler from '../src/middleware/error.middleware.js';
import { resetDiagnosticEventsForTests } from '../src/utils/diagnosticLog.js';

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
});
