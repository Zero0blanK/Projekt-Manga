import { Response } from 'express';

export interface SuccessResponse<T = unknown> {
  success: true;
  message: string;
  data: T;
}

export interface ErrorResponse {
  success: false;
  message: string;
  code?: string;
  /** Field-level messages, on a `VALIDATION_ERROR` only. */
  errors?: Record<string, string[] | undefined>;
}

/** The body a rate limiter answers with, for `express-rate-limit`'s `message` option. */
export const rateLimitBody = (message: string): ErrorResponse => ({
  success: false,
  message,
  code: 'RATE_LIMITED',
});

export const HTTPSuccessResponse = (
  res: Response,
  statusCode: number,
  message: string,
  data: unknown = null,
): Response<SuccessResponse> => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};

export const HTTPErrorResponse = (
  res: Response,
  statusCode: number,
  message: string,
  code?: string,
): Response<ErrorResponse> => {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(code ? { code } : {}),
  });
};

export const HTTPValidationErrorResponse = (
  res: Response,
  errors: Record<string, string[] | undefined>,
): Response<ErrorResponse> => {
  return res.status(400).json({
    success: false,
    message: 'Validation failed',
    code: 'VALIDATION_ERROR',
    errors,
  });
};
