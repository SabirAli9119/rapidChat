import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { getParticipantsByRoom } from '../services/chat.service';
import { registerNotificationEmitter } from '../services/notification.service';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
  TypedSocketServer,
} from '../types';
import { logger } from '../utils/logger';
import { roomChannel, userRoom } from './channels';
import { registerChatHandlers } from './chat.socket';
import { assertConnectionAllowed, authenticateSocket, sweepInvalidSockets, toConnectError } from './socketAuth';

/** How often open connections are checked for revoked sessions and banned accounts. */
export const SESSION_SWEEP_INTERVAL_MS = 15_000;
/** A connection skips the per-event session re-check for this long. */
export const SESSION_RECHECK_MS = 5_000;

const frontendOrigin = new URL(env.FRONTEND_URL).origin;

/**
 * Browsers always send an Origin header on a WebSocket handshake. Accepting only your own frontend
 * stops other websites from using a visitor's cookies to open a chat connection (cross-site WebSocket
 * hijacking). Apps and scripts send no Origin and must present a token instead.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === frontendOrigin;
}

export interface InitSocketsOptions {
  /** 0 turns the timer off (tests call sweepSessions themselves). */
  sweepIntervalMs?: number;
  /** 0 re-checks the session on every event (tests). */
  sessionRecheckMs?: number;
}

export interface SocketRuntime {
  io: TypedSocketServer;
  /** Closes connections whose session or account is no longer valid. Returns how many were closed. */
  sweepSessions: () => Promise<number>;
  /** Stops the timer and the live notifications, closes every connection AND the HTTP server. */
  close: () => Promise<void>;
}

let current: TypedSocketServer | null = null;

export function initSockets(httpServer: HttpServer, options: InitSocketsOptions = {}): SocketRuntime {
  const sweepIntervalMs = options.sweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS;
  const sessionRecheckMs = options.sessionRecheckMs ?? SESSION_RECHECK_MS;

  const io: TypedSocketServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: { origin: frontendOrigin, credentials: true },
    allowRequest: (req, callback) => {
      const allowed = isAllowedOrigin(req.headers.origin);
      callback(allowed ? null : 'Origin not allowed', allowed);
    },
    maxHttpBufferSize: 64 * 1024, // a text message is at most 2000 characters; anything bigger is refused
    serveClient: false,
  });

  io.use((socket, next) => {
    authenticateSocket(socket)
      .then(() => assertConnectionAllowed(io, socket.data.userId))
      .then(
        () => next(),
        (err: unknown) => next(toConnectError(err)),
      );
  });

  registerChatHandlers(io, { sessionRecheckMs });

  // Every notification the services create is also pushed live to that user's devices
  registerNotificationEmitter((userId, notification) => {
    io.to(userRoom(userId)).emit('notification', notification);
  });

  const sweepSessions = (): Promise<number> => sweepInvalidSockets(io);

  const timer =
    sweepIntervalMs > 0
      ? setInterval(() => {
          sweepSessions().catch((err) => logger.error({ err }, 'Session sweep failed'));
        }, sweepIntervalMs)
      : null;
  timer?.unref();

  current = io;

  return {
    io,
    sweepSessions,
    close: async () => {
      if (timer) clearInterval(timer);
      registerNotificationEmitter(null);
      if (current === io) current = null;
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}

/**
 * Tells connected clients that messages have expired and must disappear (called by the cleanup job).
 * Both people are told on every device, not only on devices that have the chat open.
 * Does nothing when no socket server runs in this process (clients also hide messages at expiresAt).
 */
export async function emitMessageExpired(items: { messageId: string; roomId: string }[]): Promise<void> {
  const io = current;
  if (!io || items.length === 0) return;

  try {
    const participants = await getParticipantsByRoom([...new Set(items.map((item) => item.roomId))]);
    for (const { messageId, roomId } of items) {
      const targets = [roomChannel(roomId), ...(participants.get(roomId) ?? []).map(userRoom)];
      io.to(targets).emit('message_expired', { messageId, roomId });
    }
  } catch (err) {
    logger.error({ err }, 'Could not announce expired messages');
  }
}