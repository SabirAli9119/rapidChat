import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface ISession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  userAgent: string | null;
  /** Friendly label, e.g. "Chrome on Windows" (built by auth.service) */
  deviceLabel: string;
  ipAddress: string | null;
  lastActiveAt: Date;
  /** Same as the refresh-token lifetime. MongoDB deletes the session after this. */
  expiresAt: Date;
  /** Set when the session is logged out, force-logged-out, or flagged as stolen */
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionDocument = HydratedDocument<ISession>;

const sessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userAgent: { type: String, default: null, maxlength: 512 },
    deviceLabel: { type: String, default: 'Unknown device', maxlength: 100 },
    ipAddress: { type: String, default: null, maxlength: 64 },
    lastActiveAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null, maxlength: 200 },
  },
  { timestamps: true },
);

sessionSchema.index({ userId: 1, revokedAt: 1 }); // "list my active sessions"
// TTL index: MongoDB automatically deletes the document once expiresAt has passed
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<ISession>('Session', sessionSchema);