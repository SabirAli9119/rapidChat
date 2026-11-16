import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { ZodError } from 'zod';
import { isDevelopment } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

interface NormalizedError {
  status: number;
  message: string;
  code?: string;
  details?: unknown;
}

function isDuplicateKeyError(err: unknown): err is { code: number; keyPattern?: Record<string, unknown> } {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

function bodyParserErrorType(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'type' in err) {
    const type = (err as { type: unknown }).type;
    return typeof type === 'string' ? type : null;
  }
  return null;
}

/** Converts ANY thrown value into a safe, consistent shape. */
function normalizeError(err: unknown): NormalizedError {
  // Errors we threw on purpose
  if (err instanceof ApiError) {
    return { status: err.statusCode, message: err.message, code: err.code, details: err.details };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      message: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    };
  }

  // Mongoose schema validation failed
  if (err instanceof mongoose.Error.ValidationError) {
    return {
      status: 400,
      message: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    };
  }

  // e.g. an invalid ObjectId in a query
  if (err instanceof mongoose.Error.CastError) {
    return { status: 400, message: `Invalid value for "${err.path}"`, code: 'INVALID_ID' };
  }

  // MongoDB unique index violated (e.g. username taken, report already filed)
  if (isDuplicateKeyError(err)) {
    const fields = Object.keys(err.keyPattern ?? {});
    return {
      status: 409,
      message: fields.length > 0 ? `A record with this ${fields.join(', ')} already exists` : 'Record already exists',
      code: 'DUPLICATE_KEY',
    };
  }

  // File upload problems
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, message: 'File is too large', code: 'FILE_TOO_LARGE' };
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return { status: 400, message: 'Unexpected file field. Use the field name "file"', code: 'UNEXPECTED_FILE' };
    }
    return { status: 400, message: err.message, code: 'UPLOAD_ERROR' };
  }

  // Errors from express.json()
  const bodyType = bodyParserErrorType(err);
  if (bodyType === 'entity.parse.failed') {
    return { status: 400, message: 'Request body is not valid JSON', code: 'MALFORMED_JSON' };
  }
  if (bodyType === 'entity.too.large') {
    return { status: 413, message: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' };
  }

  // Anything else is a bug. Never reveal what it was.
  return { status: 500, message: 'Internal server error', code: 'INTERNAL_ERROR' };
}

/** Placed after all routes: handles requests that matched nothing. */
export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  const path = req.originalUrl.split('?')[0];
  next(ApiError.notFound(`Route not found: ${req.method} ${path}`, { code: 'ROUTE_NOT_FOUND' }));
};

/** Placed LAST in app.ts. Express recognises it as an error handler by its 4 parameters. */
export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  // If a response is already partly sent we cannot send JSON, so let Express close the connection
  if (res.headersSent) {
    return _next(err);
  }

  const { status, message, code, details } = normalizeError(err);

  if (status >= 500) {
    logger.error({ err, method: req.method, url: req.originalUrl, userId: req.user?.id }, 'Unhandled error');
  } else {
    logger.debug({ status, code, method: req.method, url: req.originalUrl }, message);
  }

  res.status(status).json({
    success: false,
    message,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
    // The stack trace is only shown on your own machine while developing
    ...(isDevelopment && status >= 500 && err instanceof Error ? { stack: err.stack } : {}),
  });
};