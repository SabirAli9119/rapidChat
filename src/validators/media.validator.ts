import { z } from 'zod';
import { objectIdSchema } from './common.validator';

/** The file itself is checked by upload.middleware.ts. This checks the other form field. */
export const uploadMediaSchema = z.object({
  body: z.object({ roomId: objectIdSchema }),
});

export const mediaIdParamsSchema = z.object({
  params: z.object({ mediaId: objectIdSchema }),
});