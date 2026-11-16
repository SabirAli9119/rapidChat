// router.get('/me', authenticate, asyncHandler(userController.getMe));

import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';
import {
  authRateLimit,
  loginRateLimit,
  passwordResetRateLimit,
} from '../middlewares/rateLimit.middleware';
import { validate } from '../middlewares/validation.middleware';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  sessionIdParamsSchema,
  verifyEmailSchema,
} from '../validators/auth.validator';

const router = Router();

// ----- public -----
router.post('/register', authRateLimit, validate(registerSchema), authController.register);
// Only FAILED logins count toward this limit, so normal users never hit it
router.post('/login', loginRateLimit, validate(loginSchema), authController.login);
router.post('/refresh', authController.refresh);
// Not behind authenticate: logging out must work even when the access token has expired
router.post('/logout', authController.logout);
router.post('/verify-email', authRateLimit, validate(verifyEmailSchema), authController.verifyEmail);
router.post(
  '/forgot-password',
  passwordResetRateLimit,
  validate(forgotPasswordSchema),
  authController.forgotPassword,
);
router.post(
  '/reset-password',
  passwordResetRateLimit,
  validate(resetPasswordSchema),
  authController.resetPassword,
);

// ----- logged in -----
router.post('/resend-verification', authenticate, authRateLimit, authController.resendVerification);
// Both password-confirming routes share the failed-attempt limiter, so a stolen session can't guess the password
router.post(
  '/change-password',
  authenticate,
  loginRateLimit,
  validate(changePasswordSchema),
  authController.changePassword,
);
router.get('/sessions', authenticate, authController.listSessions);
router.delete('/sessions', authenticate, authController.logoutOtherSessions);
router.delete(
  '/sessions/:sessionId',
  authenticate,
  validate(sessionIdParamsSchema),
  authController.revokeSession,
);

export default router;