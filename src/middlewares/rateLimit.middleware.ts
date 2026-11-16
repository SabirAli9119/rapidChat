import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env, isTest } from '../config/env';
import { redis } from '../config/redis';
import { ApiError } from '../utils/ApiError';

const MINUTE_MS = 60 * 1000;

interface LimiterConfig {
  /** Used in the Redis key, so each limiter keeps its own counters */
  name: string;
  windowMs: number;
  limit: number;
  message: string;
  /** Count only failed requests (status 400 or higher) */
  skipSuccessfulRequests?: boolean;
  /** Count per logged-in user instead of per IP address (use only after authenticate) */
  keyByUser?: boolean;
  skip?: (req: Request) => boolean;
}

function buildLimiter(config: LimiterConfig): RequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    standardHeaders: 'draft-7', // sends RateLimit headers so clients can see their remaining quota
    legacyHeaders: false,
    // The limiter is built once, lazily, on the first request (see lazy() below), not per request.
    // This silences the library's "created in request handler" warning, which is a false alarm here.
    validate: { creationStack: false },
    skipSuccessfulRequests: config.skipSuccessfulRequests ?? false,
    skip: config.skip,
    ...(config.keyByUser
      ? { keyGenerator: (req: Request): string => req.user?.id ?? 'unauthenticated' }
      : {}),
    // Tests use the built-in in-memory store, so they need no Redis
    ...(isTest
      ? {}
      : {
          store: new RedisStore({
            prefix: `rl:${config.name}:`,
            sendCommand: (command: string, ...args: string[]) =>
              redis.call(command, ...args) as Promise<RedisReply>,
          }),
        }),
    handler: (_req, res, next) => {
      const retryAfter = Number(res.getHeader('Retry-After')) || undefined;
      next(
        ApiError.tooManyRequests(config.message, {
          code: 'RATE_LIMITED',
          details: retryAfter ? { retryAfterSeconds: retryAfter } : undefined,
        }),
      );
    },
  });
}

/**
 * Builds the limiter on the FIRST request instead of at import time.
 * By then server.ts has already connected to Redis, and importing this file never needs Redis.
 */
function lazy(build: () => RequestHandler): RequestHandler {
  let instance: RequestHandler | undefined;
  return (req, res, next) => {
    instance ??= build();
    instance(req, res, next);
  };
}

/** Applied to the whole API (every IP). */
export const apiRateLimit = lazy(() =>
  buildLimiter({
    name: 'api',
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * MINUTE_MS,
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    message: 'Too many requests, please slow down',
    skip: (req) => req.path === '/health',
  }),
);

/** Registration, email verification: every attempt counts. */
export const authRateLimit = lazy(() =>
  buildLimiter({
    name: 'auth',
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * MINUTE_MS,
    limit: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
    message: 'Too many attempts, please try again later',
  }),
);

/** Login: only FAILED attempts count, so normal users are never blocked. */
export const loginRateLimit = lazy(() =>
  buildLimiter({
    name: 'login',
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * MINUTE_MS,
    limit: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
    message: 'Too many failed login attempts, please try again later',
    skipSuccessfulRequests: true,
  }),
);

/** Forgot / reset password: 5 per hour per IP (stops email spam and token guessing). */
export const passwordResetRateLimit = lazy(() =>
  buildLimiter({
    name: 'password-reset',
    windowMs: 60 * MINUTE_MS,
    limit: 5,
    message: 'Too many password reset requests, please try again later',
  }),
);

/** File uploads: 20 per 10 minutes per user. Use AFTER authenticate. */
export const uploadRateLimit = lazy(() =>
  buildLimiter({
    name: 'upload',
    windowMs: 10 * MINUTE_MS,
    limit: 20,
    message: 'Too many uploads, please wait a few minutes',
    keyByUser: true,
  }),
);
/** Location updates and nearby searches: 60 per 10 minutes per user. Use AFTER authenticate. */
export const nearbyRateLimit = lazy(() =>
  buildLimiter({
    name: 'nearby',
    windowMs: 10 * MINUTE_MS,
    limit: 60,
    message: 'Too many location requests, please wait a few minutes',
    keyByUser: true,
  }),
);