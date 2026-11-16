import { z } from 'zod';

/** A MongoDB ObjectId: exactly 24 hex characters. */
export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid id');

/** Page-number pagination (used by admin lists and room/notification lists). */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Cursor pagination (used by message history). "cursor" is the id of the last message you received. */
export const cursorQuerySchema = z.object({
  cursor: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * Rules for choosing a NEW password (registration, reset, change).
 * Max 128 stops people from sending huge strings to burn CPU in the hashing step.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/\d/, 'Password must contain at least one number');

/**
 * Used when the user types their EXISTING password (login, delete account).
 * No strength rules here: old passwords must still work.
 */
export const existingPasswordSchema = z
  .string()
  .min(1, 'Password is required')
  .max(128, 'Password is too long');

// export const loginSchema = z.object({ body: z.object({ ... }) });
