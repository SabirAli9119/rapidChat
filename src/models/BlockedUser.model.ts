import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface IBlockedUser {
  _id: Types.ObjectId;
  /** The user who pressed "block" */
  blockerId: Types.ObjectId;
  /** The user who is blocked */
  blockedId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type BlockedUserDocument = HydratedDocument<IBlockedUser>;

const blockedUserSchema = new Schema<IBlockedUser>(
  {
    blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blockedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

blockedUserSchema.pre('validate', function () {
  if (this.blockerId && this.blockedId && this.blockerId.equals(this.blockedId)) {
    throw new Error('You cannot block yourself');
  }
});

// A user can block another user only once
blockedUserSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
// Reverse lookup: "has anyone blocked this user?" (blocking works in both directions)
blockedUserSchema.index({ blockedId: 1, blockerId: 1 });

export const BlockedUser = model<IBlockedUser>('BlockedUser', blockedUserSchema);