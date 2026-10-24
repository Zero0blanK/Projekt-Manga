import { describe, it, expect } from 'vitest';
import {
  AppError,
  MangaNotFoundError,
  ValidationError,
  DuplicateResourceError,
  NotFoundError,
  PrismaError,
  rethrowKnownOrWrap,
} from '../../src/utils/customErrors.js';

describe('custom error classes', () => {
  it('carry the expected status codes', () => {
    expect(new MangaNotFoundError().statusCode).toBe(404);
    expect(new ValidationError().statusCode).toBe(400);
    expect(new DuplicateResourceError().statusCode).toBe(409);
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new PrismaError().statusCode).toBe(500);
  });

  it('are all instances of AppError', () => {
    expect(new MangaNotFoundError()).toBeInstanceOf(AppError);
    expect(new ValidationError()).toBeInstanceOf(AppError);
  });
});

describe('rethrowKnownOrWrap', () => {
  it('rethrows a known AppError unchanged, preserving its status code', () => {
    const original = new MangaNotFoundError('specific message');
    expect(() => rethrowKnownOrWrap(original, new PrismaError('fallback'))).toThrowError(original);
    try {
      rethrowKnownOrWrap(original, new PrismaError('fallback'));
    } catch (err) {
      expect(err).toBe(original);
      expect((err as AppError).statusCode).toBe(404);
    }
  });

  it('wraps an unknown error with the provided fallback', () => {
    const fallback = new PrismaError('fallback message');
    try {
      rethrowKnownOrWrap(new Error('some raw db driver error'), fallback);
      expect.unreachable();
    } catch (err) {
      expect(err).toBe(fallback);
      expect((err as AppError).statusCode).toBe(500);
      expect((err as AppError).message).toBe('fallback message');
    }
  });
});
