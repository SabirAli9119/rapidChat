import type { Request, Response } from 'express';
import { extractAccessToken, requireUser } from '../middlewares/auth.middleware';
import * as authService from '../services/auth.service';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import { REFRESH_COOKIE_NAME, clearAuthCookies, setAuthCookies } from '../utils/cookies';
import { getRequestContext } from '../utils/request';
import { verifyAccessToken } from '../utils/token';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from '../validators/auth.validator';

/**
 * Refresh failures that mean "these cookies are dead". They are cleared so the browser stops sending them.
 * REFRESH_IN_PROGRESS is deliberately NOT here: another tab just got fresh cookies, so clearing would undo them.
 */
const CLEAR_COOKIES_ON = new Set([
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_REUSED',
  'SESSION_INVALID',
  'USER_NOT_FOUND',
  'ACCOUNT_BANNED',
  'ACCOUNT_SUSPENDED',
]);

export const register = asyncHandler(async (req: Request, res: Response) => {
  const user = await authService.register(req.body as RegisterInput);
  ApiResponse.created(res, { user }, 'Account created. Check your email to verify your address, then log in.');
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(req.body as LoginInput, getRequestContext(req));

  // Tokens travel ONLY in HTTP-only cookies. They are never placed in the response body.
  setAuthCookies(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
  ApiResponse.ok(res, { user: result.user }, 'Logged in');
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
  if (typeof token !== 'string' || token.length === 0) {
    throw ApiError.unauthorized('No refresh token', { code: 'NO_REFRESH_TOKEN' });
  }

  try {
    const tokens = await authService.refreshTokens(token, getRequestContext(req));
    setAuthCookies(res, tokens);
    ApiResponse.ok(res, null, 'Session refreshed');
  } catch (err) {
    if (err instanceof ApiError && err.code && CLEAR_COOKIES_ON.has(err.code)) {
      clearAuthCookies(res);
    }
    throw err;
  }
});

/**
 * Deliberately NOT behind `authenticate`: logging out must work even when the access token has
 * already expired. It ends whichever session the refresh cookie or a still-valid access token identifies,
 * and always succeeds, so a client can never get "stuck" logged in.
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const refreshToken: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    await authService.logoutWithRefreshToken(refreshToken);
  }

  const accessToken = extractAccessToken(req);
  if (accessToken) {
    try {
      await authService.logoutSession(verifyAccessToken(accessToken).sid);
    } catch {
      // expired or invalid token: nothing more to end
    }
  }

  clearAuthCookies(res);
  ApiResponse.ok(res, null, 'Logged out');
});

export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body as VerifyEmailInput;
  const user = await authService.verifyEmail(token);
  ApiResponse.ok(res, { user }, 'Email verified');
});

export const resendVerification = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  await authService.resendVerificationEmail(me.id);
  ApiResponse.ok(res, null, 'Verification email sent');
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as ForgotPasswordInput;
  authService.requestPasswordReset(email, req.ip ?? null); // runs in the background
  // The same answer whether or not the address belongs to an account
  ApiResponse.ok(res, null, 'If an account exists for that email, a reset link is on its way.');
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await authService.resetPassword(req.body as ResetPasswordInput);
  clearAuthCookies(res); // every session was ended, so the cookies in this browser are dead
  ApiResponse.ok(res, null, 'Password updated. Please log in with your new password.');
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  await authService.changePassword(me.id, me.sessionId, req.body as ChangePasswordInput);
  ApiResponse.ok(res, null, 'Password changed. Your other devices were logged out.');
});

export const listSessions = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const sessions = await authService.listSessions(me.id, me.sessionId);
  ApiResponse.ok(res, sessions, 'Active sessions');
});

export const revokeSession = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const { sessionId } = req.params;
  await authService.revokeSession(me.id, sessionId);

  const endedOwn = sessionId === me.sessionId;
  if (endedOwn) clearAuthCookies(res);
  ApiResponse.ok(res, null, endedOwn ? 'You have been logged out' : 'Device logged out');
});

export const logoutOtherSessions = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const sessionsRevoked = await authService.logoutOtherSessions(me.id, me.sessionId);
  ApiResponse.ok(res, { sessionsRevoked }, 'Other devices logged out');
});

//testing
console.log("hello");