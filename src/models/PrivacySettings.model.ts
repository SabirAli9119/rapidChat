import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface IPrivacySettings {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Opt-in. When false, the user never appears in anyone's nearby results. */
  nearbyDiscoverable: boolean;
  showOnlineStatus: boolean;
  showLastSeen: boolean;
  /** When false, nobody can open a new chat with this user (existing chats continue) */
  allowNewChats: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type PrivacySettingsDocument = HydratedDocument<IPrivacySettings>;

const privacySettingsSchema = new Schema<IPrivacySettings>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    nearbyDiscoverable: { type: Boolean, default: false },
    showOnlineStatus: { type: Boolean, default: true },
    showLastSeen: { type: Boolean, default: false },
    allowNewChats: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const PrivacySettings = model<IPrivacySettings>('PrivacySettings', privacySettingsSchema);