import { Types } from 'mongoose';
import { env } from '../config/env';
import { Media, type IMedia } from '../models/Media.model';
import { Message, notExpiredFilter, type IMessage } from '../models/Message.model';
import type { CursorPage, MessageDTO } from '../types';
import { logger } from '../utils/logger';
import type { SendMessageInput } from '../validators/message.validator';
import { assertRoomAccess, isRoomMember, touchRoom } from './chat.service';
import { claimMediaForMessage, releaseMedia, toMediaDTO } from './media.service';

export interface SentMessage {
  message: MessageDTO;
  /** The other participant. The socket layer sends them the message and the notification. */
  recipientId: string;
}

export interface DeliveryInfo {
  messageId: string;
  roomId: string;
  senderId: string;
  deliveredAt: string;
}

export function toMessageDTO(message: IMessage, media: IMedia | null): MessageDTO {
  return {
    id: String(message._id),
    roomId: String(message.roomId),
    senderId: String(message.senderId),
    type: message.type,
    content: message.content,
    media: media ? toMediaDTO(media) : null,
    status: message.status,
    createdAt: message.createdAt.toISOString(),
    expiresAt: message.expiresAt.toISOString(),
  };
}

async function loadMediaMap(messages: Pick<IMessage, 'mediaId'>[]): Promise<Map<string, IMedia>> {
  const ids = messages.map((m) => m.mediaId).filter((id): id is Types.ObjectId => id !== null);
  if (ids.length === 0) return new Map();
  const items = await Media.find({ _id: { $in: ids } }).lean<IMedia[]>();
  return new Map(items.map((media) => [String(media._id), media]));
}

// ---------- Sending ----------

/**
 * Saves a message. The server decides the expiry time (the client can never set it).
 * Rate limiting is NOT done here: the socket layer limits how fast a user may send.
 */
export async function sendMessage(senderId: string, input: SendMessageInput): Promise<SentMessage> {
  const { otherUserId } = await assertRoomAccess(input.roomId, senderId); // member, not blocked, other user active

  const expiresAt = new Date(Date.now() + env.MESSAGE_EXPIRY_MINUTES * 60 * 1000);
  const messageId = new Types.ObjectId();

  if (input.type === 'text') {
    const doc = await Message.create({
      _id: messageId,
      roomId: input.roomId,
      senderId,
      type: 'text',
      content: input.content,
      expiresAt,
    });
    await touchRoom(input.roomId, doc.createdAt);
    return { message: toMessageDTO(doc.toObject() as IMessage, null), recipientId: otherUserId };
  }

  // Media message: claim the file first (atomic), then save the message that points to it
  const media = await claimMediaForMessage({
    mediaId: input.mediaId,
    uploaderId: senderId,
    roomId: input.roomId,
    kind: input.type,
    messageId,
    messageExpiresAt: expiresAt,
  });

  try {
    const doc = await Message.create({
      _id: messageId,
      roomId: input.roomId,
      senderId,
      type: input.type,
      content: input.content ? input.content : null, // optional caption
      mediaId: media._id,
      expiresAt,
    });
    await touchRoom(input.roomId, doc.createdAt);
    return { message: toMessageDTO(doc.toObject() as IMessage, media), recipientId: otherUserId };
  } catch (err) {
    await releaseMedia(String(media._id), messageId).catch((releaseErr) =>
      logger.error({ err: releaseErr }, 'Could not release a claimed file'),
    );
    throw err;
  }
}

// ---------- History ----------

/**
 * Newest first. Pass the returned nextCursor back as `cursor` to get older messages.
 * Cursor pagination (not page numbers) because new messages keep arriving while someone scrolls.
 * Expired messages are filtered out here, even if the cleanup job has not deleted them yet.
 */
export async function listMessages(
  userId: string,
  roomId: string,
  options: { cursor?: string; limit: number },
): Promise<CursorPage<MessageDTO>> {
  await assertRoomAccess(roomId, userId);

  const docs = await Message.find({
    roomId,
    ...notExpiredFilter(),
    ...(options.cursor ? { _id: { $lt: new Types.ObjectId(options.cursor) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(options.limit + 1) // one extra tells us whether another page exists
    .lean<IMessage[]>();

  const hasMore = docs.length > options.limit;
  const page = hasMore ? docs.slice(0, options.limit) : docs;
  const mediaById = await loadMediaMap(page);

  return {
    items: page.map((m) => toMessageDTO(m, m.mediaId ? (mediaById.get(String(m.mediaId)) ?? null) : null)),
    nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
  };
}

// ---------- Delivery ----------

/**
 * Marks ONE message as delivered to `recipientId`. Returns null when there is nothing to do:
 * not the recipient's message, expired, or already delivered.
 */
export async function markMessageDelivered(messageId: string, recipientId: string): Promise<DeliveryInfo | null> {
  const message = await Message.findOne({ _id: messageId, ...notExpiredFilter() })
    .select('roomId senderId')
    .lean<Pick<IMessage, '_id' | 'roomId' | 'senderId'>>();
  if (!message || String(message.senderId) === recipientId) return null;
  if (!(await isRoomMember(String(message.roomId), recipientId))) return null;

  const deliveredAt = new Date();
  const updated = await Message.findOneAndUpdate(
    { _id: messageId, status: 'sent' }, // atomic: only one caller can flip it
    { $set: { status: 'delivered', deliveredAt } },
  ).lean();
  if (!updated) return null;

  return {
    messageId: String(message._id),
    roomId: String(message.roomId),
    senderId: String(message.senderId),
    deliveredAt: deliveredAt.toISOString(),
  };
}

/** Marks every waiting message from the OTHER person as delivered (e.g. when you open a room). */
export async function markRoomMessagesDelivered(roomId: string, recipientId: string): Promise<DeliveryInfo[]> {
  if (!(await isRoomMember(roomId, recipientId))) return [];

  const waiting = await Message.find({
    roomId,
    senderId: { $ne: recipientId },
    status: 'sent',
    ...notExpiredFilter(),
  })
    .select('_id senderId')
    .lean<Pick<IMessage, '_id' | 'senderId'>[]>();
  if (waiting.length === 0) return [];

  const deliveredAt = new Date();
  await Message.updateMany(
    { _id: { $in: waiting.map((m) => m._id) }, status: 'sent' },
    { $set: { status: 'delivered', deliveredAt } },
  );

  return waiting.map((m) => ({
    messageId: String(m._id),
    roomId,
    senderId: String(m.senderId),
    deliveredAt: deliveredAt.toISOString(),
  }));
}

// ---------- Expiry sweep (called by the message cleanup job) ----------

/**
 * Deletes messages whose time is up and returns what was removed, so the job can tell
 * connected clients with a "message_expired" event. Their files are removed by deleteExpiredMedia.
 */
export async function expireMessages(batchSize = 500): Promise<{ messageId: string; roomId: string }[]> {
  const expired = await Message.find({ expiresAt: { $lte: new Date() } })
    .sort({ expiresAt: 1 })
    .limit(batchSize)
    .select('_id roomId')
    .lean<Pick<IMessage, '_id' | 'roomId'>[]>();
  if (expired.length === 0) return [];

  await Message.deleteMany({ _id: { $in: expired.map((m) => m._id) } });
  return expired.map((m) => ({ messageId: String(m._id), roomId: String(m.roomId) }));
}