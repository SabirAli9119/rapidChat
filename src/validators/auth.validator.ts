import { z } from 'zod';
import {
  existingPasswordSchema,
  objectIdSchema,
  passwordSchema,
} from './common.validator';

const RESERVED_USERNAMES = ['admin', 'administrator', 'root', 'support', 'moderator', 'system', 'staff'];

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(/^[a-z0-9_]+$/, 'Username may only contain letters, numbers and underscores')
  .refine((value) => !RESERVED_USERNAMES.includes(value), 'This username is not available');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .email('Enter a valid email address');

/** The 64-character hex token from emailed links (see generateSecureToken in utils/token.ts). */
const emailedTokenSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid or malformed token');

export const registerSchema = z.object({
  body: z
    .object({
      username: usernameSchema,
      email: emailSchema,
      password: passwordSchema,
      displayName: z.string().trim().min(1, 'Display name is required').max(50),
    })
    .refine((data) => !data.password.toLowerCase().includes(data.username), {
      path: ['password'],
      message: 'Password must not contain your username',
    }),
});

export const loginSchema = z.object({
  body: z.object({
    /** Email address OR username */
    identifier: z.string().trim().toLowerCase().min(1, 'Email or username is required').max(254),
    password: existingPasswordSchema,
  }),
});

export const verifyEmailSchema = z.object({
  body: z.object({ token: emailedTokenSchema }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({ email: emailSchema }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: emailedTokenSchema,
    newPassword: passwordSchema,
  }),
});

export const changePasswordSchema = z.object({
  body: z
    .object({
      currentPassword: existingPasswordSchema,
      newPassword: passwordSchema,
    })
    .refine((data) => data.currentPassword !== data.newPassword, {
      path: ['newPassword'],
      message: 'New password must be different from the current password',
    }),
});

export const sessionIdParamsSchema = z.object({
  params: z.object({ sessionId: objectIdSchema }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>['body'];
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>['body'];
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>['body'];