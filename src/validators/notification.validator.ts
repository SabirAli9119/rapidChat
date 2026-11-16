import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

export const listNotificationsSchema = z.object({
  query: paginationQuerySchema.extend({
    /** Query strings are always text, so "true"/"false" is converted to a real boolean */
    unreadOnly: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  }),
});

export const notificationIdParamsSchema = z.object({
  params: z.object({ notificationId: objectIdSchema }),
});

// export const loginSchema = z.object({ body: z.object({ ... }) });