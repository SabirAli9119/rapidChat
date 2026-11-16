import { env } from '../config/env';
import { Notification, type INotification } from '../models/Notification.model';
import { User, type IUser } from '../models/User.model';
import type { NotificationDTO, NotificationType, PageResult } from '../types';
import { ApiError } from '../utils/ApiError';
import { buildPageResult, skipFor } from '../utils/db';
import { logger } from '../utils/logger';

export interface NotificationPage extends PageResult<NotificationDTO> {
  unreadCount: number;
}

export interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Small extra info the app needs, e.g. { roomId }. Never put message text here. */
  data?: Record<string, string>;
  /** Defaults to the model's retention (7 days) */
  expiresAt?: Date;
}

// ---------- Real-time delivery hook ----------

export type NotificationEmitter = (userId: string, notification: NotificationDTO) => void;

let emitter: NotificationEmitter | null = null;

/** Called once by the socket layer. Pass null to unregister (used in tests). */
export function registerNotificationEmitter(fn: NotificationEmitter | null): void {
  emitter = fn;
}

// ---------- Helpers ----------

const notExpired = (): { expiresAt: { $gt: Date } } => ({ expiresAt: { $gt: new Date() } });

export function toNotificationDTO(notification: INotification): NotificationDTO {
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: notification.data ?? {},
    read: notification.read,
    createdAt: notification.createdAt.toISOString(),
  };
}

// ---------- Creating ----------

/** Saves a notification, then pushes it live. A failing socket never loses the saved notification. */
export async function createNotification(params: CreateNotificationParams): Promise<NotificationDTO> {
  const doc = await Notification.create({
    userId: params.userId,
    type: params.type,
    title: params.title,
    body: params.body,
    data: params.data ?? {},
    ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
  });

  const dto = toNotificationDTO(doc.toObject() as INotification);

  if (emitter) {
    try {
      emitter(params.userId, dto);
    } catch (err) {
      logger.error({ err }, 'Live notification delivery failed (it is still saved)');
    }
  }
  return dto;
}

/**
 * "You have a new message". Returns null when the person already has an UNREAD notification for
 * this room, so ten messages from one person produce one notification, not ten.
 * The text is generic (never the message itself) and expires with the message.
 */
export async function notifyNewMessage(params: {
  recipientId: string;
  senderId: string;
  roomId: string;
}): Promise<NotificationDTO | null> {
  const alreadyWaiting = await Notification.exists({
    userId: params.recipientId,
    type: 'new_message',
    read: false,
    'data.roomId': params.roomId,
    ...notExpired(),
  });
  if (alreadyWaiting) return null;

  const sender = await User.findById(params.senderId).select('displayName').lean<Pick<IUser, 'displayName'>>();

  return createNotification({
    userId: params.recipientId,
    type: 'new_message',
    title: 'New message',
    body: `${sender?.displayName ?? 'Someone'} sent you a message`,
    data: { roomId: params.roomId, senderId: params.senderId },
    expiresAt: new Date(Date.now() + env.MESSAGE_EXPIRY_MINUTES * 60 * 1000),
  });
}

// ---------- Reading ----------

export async function listNotifications(
  userId: string,
  options: { page: number; limit: number; unreadOnly: boolean },
): Promise<NotificationPage> {
  const { page, limit, unreadOnly } = options;
  const filter = { userId, ...notExpired(), ...(unreadOnly ? { read: false } : {}) };

  const [docs, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .lean<INotification[]>(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId, read: false, ...notExpired() }),
  ]);

  return { ...buildPageResult(docs.map(toNotificationDTO), total, page, limit), unreadCount };
}

export async function getUnreadCount(userId: string): Promise<number> {
  return Notification.countDocuments({ userId, read: false, ...notExpired() });
}

// ---------- Marking as read ----------

/** Marking something that is already read is fine. Someone else's notification looks like "not found". */
export async function markAsRead(userId: string, notificationId: string): Promise<NotificationDTO> {
  const now = new Date();

  const updated = await Notification.findOneAndUpdate(
    { _id: notificationId, userId, read: false, expiresAt: { $gt: now } },
    { $set: { read: true, readAt: now } },
    { new: true },
  ).lean<INotification>();
  if (updated) return toNotificationDTO(updated);

  const existing = await Notification.findOne({
    _id: notificationId,
    userId,
    expiresAt: { $gt: now },
  }).lean<INotification>();
  if (!existing) {
    throw ApiError.notFound('Notification not found', { code: 'NOTIFICATION_NOT_FOUND' });
  }
  return toNotificationDTO(existing);
}

export async function markAllAsRead(userId: string): Promise<number> {
  const result = await Notification.updateMany(
    { userId, read: false, ...notExpired() },
    { $set: { read: true, readAt: new Date() } },
  );
  return result.modifiedCount;
}

/** Used when someone opens a chat: the "new message" notification for that room is now pointless. */
export async function markRoomNotificationsRead(userId: string, roomId: string): Promise<number> {
  const result = await Notification.updateMany(
    { userId, type: 'new_message', read: false, 'data.roomId': roomId },
    { $set: { read: true, readAt: new Date() } },
  );
  return result.modifiedCount;
}

// ---------- Cleanup (called by the notification job) ----------

/** The database's TTL index also does this, but only about once a minute. */
export async function deleteExpiredNotifications(): Promise<number> {
  const result = await Notification.deleteMany({ expiresAt: { $lte: new Date() } });
  return result.deletedCount;
}