import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from '../types';

export interface IUser {
  _id: Types.ObjectId;
  /** Always lowercase, used for login and as the public handle */
  username: string;
  email: string;
  passwordHash: string;
  /** Name shown to others, keeps the user's own capitalisation */
  displayName: string;
  bio: string;
  /** Storage id of the profile picture, or null if none */
  avatarPublicId: string | null;
  role: UserRole;
  status: UserStatus;
  statusReason: string | null;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  isOnline: boolean;
  lastSeenAt: Date | null;
  /** Brute-force protection: reset to 0 on successful login */
  failedLoginAttempts: number;
  /** While in the future, login is blocked even with the right password */
  lockUntil: Date | null;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  /** Set when the user deletes their account (data is anonymised, see notes) */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: [/^[a-z0-9_]+$/, 'Username may only contain letters, numbers and underscores'],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    // select: false means queries do NOT return the hash unless you ask for it
    // with .select('+passwordHash'). Only the login code does that.
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, maxlength: 50 },
    bio: { type: String, default: '', trim: true, maxlength: 300 },
    avatarPublicId: { type: String, default: null },
    // [...ARRAY] turns the readonly constant into a plain array Mongoose accepts
    role: { type: String, enum: [...USER_ROLES], default: 'user' },
    status: { type: String, enum: [...USER_STATUSES], default: 'active' },
    statusReason: { type: String, default: null, maxlength: 500 },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    isOnline: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      // Safety net: even if a document is serialised by accident, the hash never leaves.
      // The real protection is the DTO layer; this is a second lock on the door.
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

// unique indexes for username and email are created by `unique: true` above
userSchema.index({ status: 1, createdAt: -1 }); // admin: list users by status
userSchema.index({ role: 1 }); // admin: find admins/moderators

export const User = model<IUser>('User', userSchema);