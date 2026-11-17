import type { Server as SocketIOServer, Socket } from 'socket.io';

/* ==========================================================================
 * 1. Allowed values (enums)
 * --------------------------------------------------------------------------
 * Each list is declared once as a constant array. The TypeScript type is
 * derived from it, so the type and the allowed values can never disagree.
 * Mongoose schemas use the arrays (enum: USER_ROLES) and TypeScript code
 * uses the types (role: UserRole).
 * ======================================================================== */

export const USER_ROLES = ['user', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended', 'banned'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Kinds of file a user can upload. */
export const MEDIA_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** A message is either plain text or one of the media kinds. */
export const MESSAGE_TYPES = ['text', ...MEDIA_KINDS] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_STATUSES = ['sent', 'delivered'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const NOTIFICATION_TYPES = ['new_message', 'report_update', 'system'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const REPORT_TARGET_TYPES = ['user', 'message'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'inappropriate_content',
  'impersonation',
  'underage_user',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['open', 'under_review', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * Actions recorded in the admin audit log.
 * "security.*" entries are written by the system itself (no admin involved)
 * and power the security-monitoring endpoints.
 */
export const AUDIT_ACTIONS = [
  'user.suspend',
  'user.unsuspend',
  'user.ban',
  'user.unban',
  'user.role_change',
  'user.force_logout',
  'user.delete',
  'report.update_status',
  'report.resolve',
  'report.dismiss',
  'security.login_failed',
  'security.token_reuse_detected',
  'security.admin_login',
  'security.suspicious_activity',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* ==========================================================================
 * 2. Authenticated user (attached to every protected request)
 * ======================================================================== */

/**
 * Set by auth.middleware.ts after the access token is verified and the user
 * is loaded from the database. Deliberately small: no password hash, no
 * location, nothing sensitive.
 */
export interface AuthenticatedUser {
  id: string;
  username: string;
  role: UserRole;
  emailVerified: boolean;
  /** The session (logged-in device) this request belongs to */
  sessionId: string;
}

/**
 * Teaches TypeScript that Express requests can carry `req.user`.
 * Without this, writing req.user in a controller would be a type error.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/* ==========================================================================
 * 3. Pagination
 * ======================================================================== */

/** Cursor pagination: used for message history (new messages can arrive while paging). */
export interface CursorPage<T> {
  items: T[];
  /** Pass this back as ?cursor= to get the next page. null = no more pages. */
  nextCursor: string | null;
}

/** Page-number pagination: used for admin lists (users, reports, audit logs). */
export interface PageResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/* ==========================================================================
 * 4. Data sent to clients (DTOs)
 * --------------------------------------------------------------------------
 * "DTO" = Data Transfer Object: exactly what the API is allowed to expose.
 * Services convert database documents into these, so internal fields
 * (password hashes, raw storage ids, coordinates) never leak by accident.
 * Dates are ISO strings because that is what JSON and sockets carry.
 * ======================================================================== */

export interface MediaDTO {
  id: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  expiresAt: string;
  // No URL here on purpose: files are fetched through a short-lived signed
  // URL from the media endpoint, after an authorization check.
}

export interface MessageDTO {
  id: string;
  roomId: string;
  senderId: string;
  type: MessageType;
  /** Text body. null for media-only messages. */
  content: string | null;
  media: MediaDTO | null;
  status: MessageStatus;
  createdAt: string;
  /** Server-generated: createdAt + 30 minutes */
  expiresAt: string;
}

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Small extra info, e.g. { roomId: "..." } so the app can open the right chat */
  data?: Record<string, string>;
  read: boolean;
  createdAt: string;
}

/* ==========================================================================
 * 5. Socket.IO typing
 * --------------------------------------------------------------------------
 * Typed events mean a typo like socket.emit('mesage_sent') becomes a
 * compile error instead of a silent bug.
 * ======================================================================== */

/** Result object returned through Socket.IO acknowledgement callbacks. */
export type SocketAck<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface SendMessagePayload {
  roomId: string;
  type: MessageType;
  /** Required when type is "text" */
  content?: string;
  /** Required for media types. The file is uploaded first via POST /api/v1/media. */
  mediaId?: string;
}

export interface RoomPayload {
  roomId: string;
}

/** Events the CLIENT sends to the SERVER. */
export interface ClientToServerEvents {
  join_room: (payload: RoomPayload, ack: (res: SocketAck<RoomPayload>) => void) => void;
  leave_room: (payload: RoomPayload, ack: (res: SocketAck<RoomPayload>) => void) => void;
  send_message: (payload: SendMessagePayload, ack: (res: SocketAck<MessageDTO>) => void) => void;
  typing_start: (payload: RoomPayload) => void;
  typing_stop: (payload: RoomPayload) => void;
}

/** Events the SERVER sends to the CLIENT. */
export interface ServerToClientEvents {
  /**
   * Sent to everyone in the room (including the sender). The sender treats it
   * as confirmation; the other participant treats it as an incoming message.
   */
  message_sent: (message: MessageDTO) => void;
  /** Tells the sender the other participant's device received the message. */
  message_delivered: (payload: { messageId: string; roomId: string; deliveredAt: string }) => void;
  /** The 30 minutes are up: clients must remove the message (and its media). */
  message_expired: (payload: { messageId: string; roomId: string }) => void;
  typing_start: (payload: { roomId: string; userId: string }) => void;
  typing_stop: (payload: { roomId: string; userId: string }) => void;
  user_online: (payload: { userId: string }) => void;
  // user_offline: (payload: { userId: string; lastSeenAt: string }) => void;
    user_offline: (payload: { userId: string; lastSeenAt: string | null }) => void;
  /** The server is ending this connection (logged out, banned, session expired...). Send the user to the login screen. */
  session_ended: (payload: { code: string }) => void;
  notification: (notification: NotificationDTO) => void;
}

/** Events between multiple server instances. Unused for now, but Socket.IO requires the slot. */
export interface InterServerEvents {
  ping: () => void;
}

/** Data stored on each socket after it authenticates. */
export interface SocketData {
  userId: string;
  sessionId: string;
  role: UserRole;
}

export type TypedSocketServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;