import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { NOTIFICATION_TYPES, type NotificationType } from '../types';

export const NOTIFICATION_RETENTION_DAYS = 7;

export interface INotification {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  /**
   * Keep this generic ("You have a new message"). Never copy message text here:
   * messages are meant to disappear after 30 minutes, notifications must not outlive them.
   */
  body: string;
  /** Small extra info the app needs, e.g. { roomId: "..." } */
  data: Record<string, string>;
  read: boolean;
  readAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<INotification>;

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: [...NOTIFICATION_TYPES], required: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    body: { type: String, required: true, trim: true, maxlength: 300 },
    data: { type: Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    },
  },
  {
    timestamps: true,
    minimize: false, // keep empty "data" objects instead of dropping them
  },
);

// "My notifications, unread first / newest first" and "how many unread?"
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Notification = model<INotification>('Notification', notificationSchema);