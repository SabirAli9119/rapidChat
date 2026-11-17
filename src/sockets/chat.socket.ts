import type { z } from 'zod';
import {
  assertRoomAccess,
  listContactIds,
} from '../services/chat.service';
import {
  markAllMessagesDelivered,
  markMessageDelivered,
  markRoomMessagesDelivered,
  sendMessage,
  type DeliveryInfo,
} from '../services/message.service';
import { markRoomNotificationsRead, notifyNewMessage } from '../services/notification.service';
import * as presence from '../services/presence.service';
import { getPrivacySettings } from '../services/privacy.service';
import type { MessageDTO, SocketAck, TypedSocket, TypedSocketServer } from '../types';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { roomPayloadSchema, sendMessagePayloadSchema } from '../validators/message.validator';
import { ROOM_CHANNEL_PREFIX, roomChannel, userRoom } from './channels';
import { FixedWindowLimiter } from './rateLimiter';
import {
  assertSocketActive,
  endSocket,
  isSessionProblem,
  markSocketValidated,
} from './socketAuth';

/** Per user, across all their devices. */
export const SEND_LIMIT = { limit: 30, windowMs: 60_000 };
export const JOIN_LIMIT = { limit: 60, windowMs: 60_000 };
export const TYPING_LIMIT = { limit: 20, windowMs: 10_000 };
/** One socket may have this many chats open at once. */
export const MAX_JOINED_ROOMS = 100;

export interface ChatSocketOptions {
  /** How long a connection may skip the session re-check. 0 = check on every event. */
  sessionRecheckMs: number;
}

interface Limiters {
  send: FixedWindowLimiter;
  join: FixedWindowLimiter;
  typing: FixedWindowLimiter;
}

// ---------- Helpers ----------

function parsePayload<S extends z.ZodType>(schema: S, payload: unknown): z.infer<S> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw ApiError.badRequest('Invalid request', {
      code: 'VALIDATION_ERROR',
      details: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data as z.infer<S>;
}

function takeToken(limiter: FixedWindowLimiter, key: string, what: string): void {
  const result = limiter.consume(key);
  if (!result.allowed) {
    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    throw ApiError.tooManyRequests(`${what} Try again in ${seconds} seconds.`, { code: 'RATE_LIMITED' });
  }
}

type AckFn<T> = (response: SocketAck<T>) => void;

function toAckError(err: unknown): SocketAck<never> {
  if (err instanceof ApiError) {
    return { ok: false, error: { code: err.code ?? 'ERROR', message: err.message } };
  }
  logger.error({ err }, 'Unexpected error in a socket event handler');
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };
}

/**
 * Wraps an event handler so it ALWAYS answers: { ok: true, data } or { ok: false, error }.
 * A client that forgets the callback is tolerated. When the failure means the session is over,
 * the answer is sent first and the connection is closed afterwards.
 */
function withAck<T>(socket: TypedSocket, run: (payload: unknown) => Promise<T>) {
  return async (payload: unknown, ack?: unknown): Promise<void> => {
    const reply: AckFn<T> = typeof ack === 'function' ? (ack as AckFn<T>) : () => undefined;
    try {
      reply({ ok: true, data: await run(payload) });
    } catch (err) {
      reply(toAckError(err));
      if (err instanceof ApiError && err.code && isSessionProblem(err.code)) {
        endSocket(socket, err.code);
      }
    }
  };
}

/** For events without a reply (typing): bad input is ignored. */
function quiet(run: (payload: unknown) => Promise<void>) {
  return async (payload: unknown): Promise<void> => {
    try {
      await run(payload);
    } catch (err) {
      logger.debug({ err }, 'Ignored an invalid socket event');
    }
  };
}

const joinedRoomCount = (socket: TypedSocket): number =>
  [...socket.rooms].filter((room) => room.startsWith(ROOM_CHANNEL_PREFIX)).length;

function announceDelivered(io: TypedSocketServer, items: DeliveryInfo[]): void {
  for (const item of items) {
    io.to(userRoom(item.senderId)).emit('message_delivered', {
      messageId: item.messageId,
      roomId: item.roomId,
      deliveredAt: item.deliveredAt,
    });
  }
}

/**
 * Tells the people this user chats with that they came online or went offline.
 * Only people they share a chat with (and have not blocked) hear about it, and nothing is sent
 * when the user hides their online status. "Last seen" is withheld unless they allow it.
 */
async function announcePresence(
  io: TypedSocketServer,
  userId: string,
  change: { type: 'online' } | { type: 'offline'; at: Date },
): Promise<void> {
  const settings = await getPrivacySettings(userId);
  if (!settings.showOnlineStatus) return;

  const contacts = await listContactIds(userId);
  if (contacts.length === 0) return;
  const targets = contacts.map(userRoom);

  if (change.type === 'online') {
    io.to(targets).emit('user_online', { userId });
  } else {
    io.to(targets).emit('user_offline', {
      userId,
      lastSeenAt: settings.showLastSeen ? change.at.toISOString() : null,
    });
  }
}

// ---------- Connection lifecycle ----------

async function onConnected(io: TypedSocketServer, socket: TypedSocket): Promise<void> {
  const { userId } = socket.data;
  await socket.join(userRoom(userId));

  try {
    const { cameOnline } = await presence.userConnected(userId, socket.id);
    if (cameOnline) await announcePresence(io, userId, { type: 'online' });
  } catch (err) {
    logger.error({ err }, 'Presence update failed on connect');
  }

  try {
    // Messages that arrived while this user was away are now delivered
    announceDelivered(io, await markAllMessagesDelivered(userId));
  } catch (err) {
    logger.error({ err }, 'Could not mark waiting messages as delivered');
  }
}

async function onDisconnected(io: TypedSocketServer, socket: TypedSocket): Promise<void> {
  const { userId } = socket.data;
  try {
    const { wentOffline, lastSeenAt } = await presence.userDisconnected(userId, socket.id);
    if (wentOffline && lastSeenAt) await announcePresence(io, userId, { type: 'offline', at: lastSeenAt });
  } catch (err) {
    logger.error({ err }, 'Presence update failed on disconnect');
  }
}

/** Runs after a message is saved and announced: delivery tracking, then the notification. */
async function afterSend(
  io: TypedSocketServer,
  message: MessageDTO,
  senderId: string,
  recipientId: string,
): Promise<void> {
  try {
    const recipientConnected = (await io.in(userRoom(recipientId)).fetchSockets()).length > 0;
    if (recipientConnected) {
      const delivered = await markMessageDelivered(message.id, recipientId);
      if (delivered) announceDelivered(io, [delivered]);
    }
  } catch (err) {
    logger.error({ err }, 'Delivery tracking failed');
  }

  try {
    // No notification when the recipient is looking at this very chat
    const viewing = (await io.in(roomChannel(message.roomId)).fetchSockets()).some(
      (s) => s.data.userId === recipientId,
    );
    if (!viewing) await notifyNewMessage({ recipientId, senderId, roomId: message.roomId });
  } catch (err) {
    logger.error({ err }, 'Could not create the new-message notification');
  }
}

function handleConnection(
  io: TypedSocketServer,
  socket: TypedSocket,
  options: ChatSocketOptions,
  limiters: Limiters,
): void {
  const { userId } = socket.data;
  const typingIn = new Set<string>();
  markSocketValidated(socket);

  const stopTyping = (roomId: string): void => {
    if (typingIn.delete(roomId)) {
      socket.to(roomChannel(roomId)).emit('typing_stop', { roomId, userId });
    }
  };

  // Handlers are attached BEFORE anything asynchronous happens, so no early event is ever missed

  socket.on(
    'join_room',
    withAck(socket, async (payload) => {
      const { roomId } = parsePayload(roomPayloadSchema, payload);
      takeToken(limiters.join, userId, 'Too many requests.');
      await assertSocketActive(socket, options.sessionRecheckMs);

      const channel = roomChannel(roomId);
      if (!socket.rooms.has(channel) && joinedRoomCount(socket) >= MAX_JOINED_ROOMS) {
        throw ApiError.badRequest('You have too many chats open', { code: 'TOO_MANY_ROOMS' });
      }

      await assertRoomAccess(roomId, userId); // member, not blocked, other person still active
      await socket.join(channel);

      try {
        announceDelivered(io, await markRoomMessagesDelivered(roomId, userId));
        await markRoomNotificationsRead(userId, roomId);
      } catch (err) {
        logger.error({ err }, 'Could not update delivery state when joining a room');
      }
      return { roomId };
    }),
  );

  socket.on(
    'leave_room',
    withAck(socket, async (payload) => {
      const { roomId } = parsePayload(roomPayloadSchema, payload);
      stopTyping(roomId); // do not leave a "typing..." indicator behind
      await socket.leave(roomChannel(roomId));
      return { roomId };
    }),
  );

  socket.on(
    'send_message',
    withAck(socket, async (payload) => {
      const input = parsePayload(sendMessagePayloadSchema, payload);
      takeToken(limiters.send, userId, 'You are sending messages too fast.');
      await assertSocketActive(socket, options.sessionRecheckMs);

      // The service decides everything that matters: membership, blocking, expiry time, media ownership
      const { message, recipientId } = await sendMessage(userId, input);

      // One broadcast to the open chat plus both people's devices. Each socket receives it once,
      // even when it is in several of these channels.
      io.to(roomChannel(message.roomId)).to(userRoom(recipientId)).to(userRoom(userId)).emit('message_sent', message);

      await afterSend(io, message, userId, recipientId);
      return message;
    }),
  );

  socket.on(
    'typing_start',
    quiet(async (payload) => {
      const { roomId } = parsePayload(roomPayloadSchema, payload);
      const channel = roomChannel(roomId);
      if (!socket.rooms.has(channel)) return; // only someone who joined (and was authorised) can type here
      if (!limiters.typing.consume(userId).allowed) return;

      typingIn.add(roomId);
      socket.to(channel).emit('typing_start', { roomId, userId });
    }),
  );

  socket.on(
    'typing_stop',
    quiet(async (payload) => {
      const { roomId } = parsePayload(roomPayloadSchema, payload);
      if (!socket.rooms.has(roomChannel(roomId))) return;
      stopTyping(roomId); // only emits if a typing_start came first, so it cannot be used to spam
    }),
  );

  // "disconnecting" fires while the socket is still in its rooms, so the stop can still be delivered
  socket.on('disconnecting', () => {
    for (const roomId of [...typingIn]) stopTyping(roomId);
  });
  socket.on('disconnect', () => {
    void onDisconnected(io, socket);
  });

  void onConnected(io, socket);
}

export function registerChatHandlers(io: TypedSocketServer, options: ChatSocketOptions): void {
  const limiters: Limiters = {
    send: new FixedWindowLimiter(SEND_LIMIT.limit, SEND_LIMIT.windowMs),
    join: new FixedWindowLimiter(JOIN_LIMIT.limit, JOIN_LIMIT.windowMs),
    typing: new FixedWindowLimiter(TYPING_LIMIT.limit, TYPING_LIMIT.windowMs),
  };
  io.on('connection', (socket) => handleConnection(io, socket, options, limiters));
}