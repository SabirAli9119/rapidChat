export interface ApiErrorOptions {
  /** Machine-readable code the frontend can react to, e.g. "TOKEN_EXPIRED" */
  code?: string;
  /** Extra info, e.g. validation errors per field */
  details?: unknown;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = options.code;
    this.details = options.details;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', options?: ApiErrorOptions): ApiError {
    return new ApiError(400, message, options);
  }

  static unauthorized(message = 'Authentication required', options?: ApiErrorOptions): ApiError {
    return new ApiError(401, message, options);
  }

  static forbidden(message = 'You do not have permission to do this', options?: ApiErrorOptions): ApiError {
    return new ApiError(403, message, options);
  }

  static notFound(message = 'Resource not found', options?: ApiErrorOptions): ApiError {
    return new ApiError(404, message, options);
  }

  static conflict(message = 'Resource already exists', options?: ApiErrorOptions): ApiError {
    return new ApiError(409, message, options);
  }

  static gone(message = 'Resource is no longer available', options?: ApiErrorOptions): ApiError {
    return new ApiError(410, message, options);
  }

  static payloadTooLarge(message = 'Payload too large', options?: ApiErrorOptions): ApiError {
    return new ApiError(413, message, options);
  }

  static unprocessable(message = 'Unprocessable request', options?: ApiErrorOptions): ApiError {
    return new ApiError(422, message, options);
  }

  static tooManyRequests(message = 'Too many requests, please try again later', options?: ApiErrorOptions): ApiError {
    return new ApiError(429, message, options);
  }

  static internal(message = 'Internal server error', options?: ApiErrorOptions): ApiError {
    return new ApiError(500, message, options);
  }
}