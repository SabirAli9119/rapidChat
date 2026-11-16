import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { ApiError } from '../utils/ApiError';

interface ParsedRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/**
 * Usage in a route:  router.post('/login', validate(loginSchema), controller.login)
 *
 * On success, req.body / req.query / req.params are REPLACED by the cleaned values
 * (trimmed, lowercased, converted to numbers, unknown fields removed).
 * On failure, a 400 error listing every problem is passed to the error middleware.
 */
export const validate =
  (schema: ZodType): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return next(ApiError.badRequest('Validation failed', { code: 'VALIDATION_ERROR', details }));
    }

    const data = result.data as ParsedRequest;
    // Only replace the parts this schema actually describes
    if (data.body !== undefined) req.body = data.body;
    if (data.query !== undefined) req.query = data.query as Request['query'];
    if (data.params !== undefined) req.params = data.params as Request['params'];

    next();
  };