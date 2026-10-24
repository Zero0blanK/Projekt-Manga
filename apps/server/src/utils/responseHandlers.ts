import { Response } from 'express';

export interface SuccessResponse<T = unknown> {
  success: true;
  message: string;
  data: T;
}

export interface ErrorResponse {
  success: false;
  message: string;
}

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
): Response<ErrorResponse> => {
  return res.status(statusCode).json({
    success: false,
    message,
  });
};
