import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { env } from '../config/env';
import { MEDIA_KINDS, type MediaKind } from '../types';

/** Absolute ceiling (10 MB). MAX_FILE_SIZE_MB in .env can only make it smaller. */
export const MAX_MEDIA_SIZE_BYTES = 10 * 1024 * 1024;

/** pending = uploaded but not yet sent in a message, attached = belongs to a message */
export const MEDIA_STATUSES = ['pending', 'attached'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** Cloudinary's own categories. Audio is stored as "video"; documents as "raw". */
export const STORAGE_RESOURCE_TYPES = ['image', 'video', 'raw'] as const;
export type StorageResourceType = (typeof STORAGE_RESOURCE_TYPES)[number];

export interface IMedia {
  _id: Types.ObjectId;
  uploaderId: Types.ObjectId;
  /** Only the two participants of this room may access the file */
  roomId: Types.ObjectId;
  /** null until the file is attached to a message */
  messageId: Types.ObjectId | null;
  status: MediaStatus;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  /** Identifier of the file in private storage (never sent to clients) */
  storagePublicId: string;
  storageResourceType: StorageResourceType;
  /**
   * While pending: upload time + MESSAGE_EXPIRY_MINUTES (send it or lose it).
   * When attached: set to the message's expiresAt, so file and message expire together.
   */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type MediaDocument = HydratedDocument<IMedia>;

const mediaSchema = new Schema<IMedia>(
  {
    uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    roomId: { type: Schema.Types.ObjectId, ref: 'ChatRoom', required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    status: { type: String, enum: [...MEDIA_STATUSES], default: 'pending' },
    kind: { type: String, enum: [...MEDIA_KINDS], required: true },
    mimeType: { type: String, required: true, maxlength: 127 },
    sizeBytes: { type: Number, required: true, min: 1, max: MAX_MEDIA_SIZE_BYTES },
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    storagePublicId: { type: String, required: true, unique: true },
    storageResourceType: { type: String, enum: [...STORAGE_RESOURCE_TYPES], required: true },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + env.MESSAGE_EXPIRY_MINUTES * 60 * 1000),
    },
  },
  { timestamps: true },
);

// The cleanup job asks: "which files have expired?"
mediaSchema.index({ expiresAt: 1 });
mediaSchema.index({ messageId: 1 });
mediaSchema.index({ uploaderId: 1, status: 1 });

// NOTE: there is intentionally NO TTL index here. If MongoDB deleted the record
// by itself, the actual file in storage would be orphaned forever. The cleanup job
// deletes the file first and the record second.

export const Media = model<IMedia>('Media', mediaSchema);