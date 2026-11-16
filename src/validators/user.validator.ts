import { z } from 'zod';
import { existingPasswordSchema, objectIdSchema } from './common.validator';

export const updateProfileSchema = z.object({
  body: z
    .object({
      displayName: z.string().trim().min(1, 'Display name cannot be empty').max(50).optional(),
      bio: z.string().trim().max(300, 'Bio must be at most 300 characters').optional(),
    })
    .refine((data) => data.displayName !== undefined || data.bio !== undefined, {
      message: 'Provide at least one field to update',
    }),
});

export const updatePrivacySchema = z.object({
  body: z
    .object({
      nearbyDiscoverable: z.boolean().optional(),
      showOnlineStatus: z.boolean().optional(),
      showLastSeen: z.boolean().optional(),
      allowNewChats: z.boolean().optional(),
    })
    .refine((data) => Object.values(data).some((value) => value !== undefined), {
      message: 'Provide at least one setting to update',
    }),
});

export const userIdParamsSchema = z.object({
  params: z.object({ userId: objectIdSchema }),
});

/** Deleting an account is permanent, so we ask for the password AND a typed confirmation. */
export const deleteAccountSchema = z.object({
  body: z.object({
    password: existingPasswordSchema,
    confirmation: z.literal('DELETE'),
  }),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>['body'];
export type UpdatePrivacyInput = z.infer<typeof updatePrivacySchema>['body'];