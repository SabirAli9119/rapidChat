import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface IRefreshToken {
  _id: Types.ObjectId;
  /** Unique token id, same value as the "jti" claim inside the JWT */
  jti: string;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  /** SHA-256 of the token. The token itself is never stored. */
  tokenHash: string;
  expiresAt: Date;
  /** Set the moment this token is exchanged for a new one */
  usedAt: Date | null;
  /** The jti of the token that replaced this one (the rotation chain) */
  replacedByJti: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RefreshTokenDocument = HydratedDocument<IRefreshToken>;

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    jti: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    replacedByJti: { type: String, default: null },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ sessionId: 1 }); // revoke all tokens of a session
refreshTokenSchema.index({ userId: 1 }); // revoke all tokens of a user
// Used tokens are kept until they expire so reuse can still be detected
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model<IRefreshToken>('RefreshToken', refreshTokenSchema);