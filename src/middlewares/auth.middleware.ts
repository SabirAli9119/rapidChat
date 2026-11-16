import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Session } from '../models/Session.model';
import { User } from '../models/User.model';
import type { AuthenticatedUser, UserRole } from '../types';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { ACCESS_COOKIE_NAME } from '../utils/cookies';
import { logger } from '../utils/logger';
import { verifyAccessToken } from '../utils/token';

/** "Last active" is only written to the database this often, not on every request. */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Turns an access token into a verified user, or throws a 401/403 ApiError.
 * Checks: signature + expiry, session still valid (not logged out), user exists,
 * and the account is not banned or suspended. Used by BOTH the REST API and Socket.IO.
 */
export async function resolveUserFromAccessToken(token: string): Promise<AuthenticatedUser> {
  const payload = verifyAccessToken(token); // throws TOKEN_EXPIRED / INVALID_TOKEN

  const session = await Session.findOne({
    _id: payload.sid,
    userId: payload.sub,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .select('lastActiveAt')
    .lean();

  if (!session) {
    throw ApiError.unauthorized('Your session has ended. Please log in again.', { code: 'SESSION_INVALID' });
  }

  const user = await User.findById(payload.sub)
    .select('username role status emailVerified deletedAt')
    .lean();

  if (!user || user.deletedAt) {
    throw ApiError.unauthorized('Account not found', { code: 'USER_NOT_FOUND' });
  }
  if (user.status === 'banned') {
    throw ApiError.forbidden('Your account has been banned', { code: 'ACCOUNT_BANNED' });
  }
  if (user.status === 'suspended') {
    throw ApiError.forbidden('Your account is suspended', { code: 'ACCOUNT_SUSPENDED' });
  }

  // Refresh "last active" occasionally, in the background (a failure must not break the request)
  if (Date.now() - new Date(session.lastActiveAt).getTime() > SESSION_TOUCH_INTERVAL_MS) {
    Session.updateOne({ _id: session._id }, { lastActiveAt: new Date() })
      .exec()
      .catch((err) => logger.warn({ err }, 'Could not update session activity'));
  }

  return {
    id: String(user._id),
    username: user.username,
    role: user.role,
    emailVerified: user.emailVerified,
    sessionId: String(session._id),
  };
}

/** The token comes from the HTTP-only cookie (browsers) or an "Authorization: Bearer" header (Postman, mobile). */
function extractAccessToken(req: Request): string | null {
  const cookieToken: unknown = req.cookies?.[ACCESS_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length > 0) return cookieToken;

  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

/** Protects a route. After it runs, req.user is guaranteed to be set. */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = extractAccessToken(req);
  if (!token) {
    throw ApiError.unauthorized('Authentication required', { code: 'NO_TOKEN' });
  }
  req.user = await resolveUserFromAccessToken(token);
  next();
});

/** Use AFTER authenticate on routes that need a verified email (nearby, chat). */
export const requireVerifiedEmail: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(ApiError.unauthorized('Authentication required', { code: 'NO_TOKEN' }));
  if (!req.user.emailVerified) {
    return next(ApiError.forbidden('Please verify your email address first', { code: 'EMAIL_NOT_VERIFIED' }));
  }
  next();
};

/**
 * Role-based access control. Use AFTER authenticate.
 *   requireRole('admin')                 -> admins only
 *   requireRole('admin', 'moderator')    -> either role
 */
export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized('Authentication required', { code: 'NO_TOKEN' }));
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden('You do not have permission to do this', { code: 'INSUFFICIENT_ROLE' }));
    }
    next();
  };

/** For controllers: returns req.user, or throws 401 if authenticate was forgotten on the route. */
export function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) throw ApiError.unauthorized('Authentication required', { code: 'NO_TOKEN' });
  return req.user;
}