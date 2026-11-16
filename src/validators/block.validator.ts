import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

/** Used for both POST /blocks/:userId (block) and DELETE /blocks/:userId (unblock). */
export const blockParamsSchema = z.object({
  params: z.object({ userId: objectIdSchema }),
});

export const listBlocksSchema = z.object({
  query: paginationQuerySchema,
});