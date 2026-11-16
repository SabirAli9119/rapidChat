import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface IPasswordResetToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** SHA-256 of the token emailed to the user */
  tokenHash: string;
  expiresAt: Date;
  /** Set when the token is used. A used token can never be used again. */
  usedAt: Date | null;
  requestedFromIp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PasswordResetTokenDocument = HydratedDocument<IPasswordResetToken>;

const passwordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    requestedFromIp: { type: String, default: null, maxlength: 64 },
  },
  { timestamps: true },
);

passwordResetTokenSchema.index({ userId: 1 }); // invalidate older tokens when a new one is requested
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = model<IPasswordResetToken>(
  'PasswordResetToken',
  passwordResetTokenSchema,
);