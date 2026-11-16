import { z } from 'zod';
import { MESSAGE_MAX_LENGTH } from '../models/Message.model';
import { MEDIA_KINDS } from '../types';
import { cursorQuerySchema, objectIdSchema } from './common.validator';

const textContentSchema = z
  .string()
  .trim()
  .min(1, 'Message cannot be empty')
  .max(MESSAGE_MAX_LENGTH, `Message must be at most ${MESSAGE_MAX_LENGTH} characters`);

/**
 * Payload of the Socket.IO "send_message" event.
 * - text message: needs content
 * - media message: needs mediaId (the file was uploaded first via POST /api/v1/media); content is an optional caption
 */
export const sendMessagePayloadSchema = z.union([
  z.object({
    roomId: objectIdSchema,
    type: z.literal('text'),
    content: textContentSchema,
  }),
  z.object({
    roomId: objectIdSchema,
    type: z.enum(MEDIA_KINDS),
    mediaId: objectIdSchema,
    content: z.string().trim().max(MESSAGE_MAX_LENGTH).optional(),
  }),
]);

/** Payload of join_room, leave_room, typing_start and typing_stop. */
export const roomPayloadSchema = z.object({ roomId: objectIdSchema });

/** GET /api/v1/rooms/:roomId/messages?cursor=...&limit=... */
export const listMessagesSchema = z.object({
  params: z.object({ roomId: objectIdSchema }),
  query: cursorQuerySchema,
});

export type SendMessageInput = z.infer<typeof sendMessagePayloadSchema>;
export type RoomPayloadInput = z.infer<typeof roomPayloadSchema>;