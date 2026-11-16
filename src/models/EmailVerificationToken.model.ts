import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface IEmailVerificationToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** The exact address being verified (protects against the email changing mid-flow) */
  email: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type EmailVerificationTokenDocument = HydratedDocument<IEmailVerificationToken>;

const emailVerificationTokenSchema = new Schema<IEmailVerificationToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

emailVerificationTokenSchema.index({ userId: 1 });
emailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerificationToken = model<IEmailVerificationToken>(
  'EmailVerificationToken',
  emailVerificationTokenSchema,
);