import type { CookieOptions, Response } from 'express';
import { env, isProduction } from '../config/env';

export const ACCESS_COOKIE_NAME = 'access_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** The refresh cookie is only sent to the auth endpoints, never to the rest of the API. */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function baseOptions(path: string): CookieOptions {
  return {
    httpOnly: true, // JavaScript cannot read it (blocks XSS token theft)
    secure: isProduction, // https only in production
    sameSite: 'lax', // not sent on cross-site POST requests (CSRF protection)
    path,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
): void {
  res.cookie(ACCESS_COOKIE_NAME, tokens.accessToken, {
    ...baseOptions('/'),
    maxAge: env.JWT_ACCESS_EXPIRES_IN_MINUTES * MINUTE_MS,
  });

  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    ...baseOptions(REFRESH_COOKIE_PATH),
    maxAge: env.JWT_REFRESH_EXPIRES_IN_DAYS * DAY_MS,
  });
}

export function clearAuthCookies(res: Response): void {
  // The path/domain must match the ones used when the cookie was set
  res.clearCookie(ACCESS_COOKIE_NAME, baseOptions('/'));
  res.clearCookie(REFRESH_COOKIE_NAME, baseOptions(REFRESH_COOKIE_PATH));
}