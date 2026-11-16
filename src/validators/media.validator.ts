import { z } from 'zod';
import { objectIdSchema } from './common.validator';

/** The file itself is checked by upload.middleware.ts. This checks the other form field. */
export const uploadMediaSchema = z.object({
  body: z.object({ roomId: objectIdSchema }),
});

export const mediaIdParamsSchema = z.object({
  params: z.object({ mediaId: objectIdSchema }),
});

/**
 * GET /api/v1/media/:mediaId/file
 * Either send no query (normal login), or send all three of uid, exp and sig (signed link).
 */
export const mediaFileSchema = z.object({
  params: z.object({ mediaId: objectIdSchema }),
  query: z
    .object({
      uid: objectIdSchema.optional(),
      exp: z.coerce.number().int().positive().optional(),
      sig: z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid signature').optional(),
    })
    .refine(
      (q) => {
        const given = [q.uid, q.exp, q.sig].filter((value) => value !== undefined).length;
        return given === 0 || given === 3;
      },
      { message: 'uid, exp and sig must be provided together' },
    ),
});