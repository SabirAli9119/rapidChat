import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { env } from '../config/env';
import {
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  type MessageStatus,
  type MessageType,
} from '../types';

export const MESSAGE_MAX_LENGTH = 2000;

export interface IMessage {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  senderId: Types.ObjectId;
  type: MessageType;
  /** Text body, or an optional caption for media messages */
  content: string | null;
  mediaId: Types.ObjectId | null;
  status: MessageStatus;
  deliveredAt: Date | null;
  /** Server-generated: creation time + MESSAGE_EXPIRY_MINUTES. Clients can never set it. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageDocument = HydratedDocument<IMessage>;

/**
 * Use this in EVERY query that reads messages, so expired messages are hidden
 * immediately, even if the cleanup job has not deleted them yet.
 *   Message.find({ roomId, ...notExpiredFilter() })
 */
export function notExpiredFilter(): { expiresAt: { $gt: Date } } {
  return { expiresAt: { $gt: new Date() } };
}

const messageSchema = new Schema<IMessage>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'ChatRoom', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: [...MESSAGE_TYPES], required: true },
    content: { type: String, default: null, trim: true, maxlength: MESSAGE_MAX_LENGTH },
    mediaId: { type: Schema.Types.ObjectId, ref: 'Media', default: null },
    status: { type: String, enum: [...MESSAGE_STATUSES], default: 'sent' },
    deliveredAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      required: true,
      immutable: true, // cannot be changed after creation
      default: () => new Date(Date.now() + env.MESSAGE_EXPIRY_MINUTES * 60 * 1000),
    },
  },
  { timestamps: true },
);

// Text messages need text; media messages need a media reference.
// Text messages need text; media messages need a media reference.
messageSchema.pre('validate', function () {
  if (this.type === 'text') {
    if (!this.content || this.content.trim().length === 0) {
      throw new Error('Text messages need content');
    }
    if (this.mediaId) {
      throw new Error('Text messages cannot have media');
    }
  } else if (!this.mediaId) {
    throw new Error('Media messages need a mediaId');
  }
});

// Message history: newest first, paged with the _id of the last item as the cursor
messageSchema.index({ roomId: 1, _id: -1 });

// Safety net only: deletes 5 minutes AFTER expiry. The cleanup job normally removes
// messages first, so it can notify clients and delete files; this catches anything it missed.
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 300 });

export const Message = model<IMessage>('Message', messageSchema);