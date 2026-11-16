import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common.validator';

/** Create a room with another user, or fetch the existing one. */
export const createRoomSchema = z.object({
  body: z.object({ userId: objectIdSchema }),
});

export const roomIdParamsSchema = z.object({
  params: z.object({ roomId: objectIdSchema }),
});

export const listRoomsSchema = z.object({
  query: paginationQuerySchema,
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>['body'];