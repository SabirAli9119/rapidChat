import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export interface IChatRoom {
  _id: Types.ObjectId;
  /** Exactly two different users */
  participants: Types.ObjectId[];
  /**
   * Both user ids, sorted and joined: "idA:idB". The unique index on this field
   * guarantees one room per pair of users, even if two requests race each other.
   */
  participantKey: string;
  createdBy: Types.ObjectId;
  /** Used to sort the room list. Starts as the creation time. */
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ChatRoomDocument = HydratedDocument<IChatRoom>;

/**
 * Builds the canonical key for a pair of users. The order of the arguments does not matter.
 * Services MUST use this when looking up a room (findOne({ participantKey })).
 */
export function buildParticipantKey(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(':');
}

const chatRoomSchema = new Schema<IChatRoom>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (value: Types.ObjectId[]): boolean =>
          value.length === 2 && value[0].toString() !== value[1].toString(),
        message: 'A room must have exactly two different participants',
      },
    },
    participantKey: { type: String, required: true, unique: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Runs automatically before validation: computes the key and checks the creator.
// Runs automatically before validation: computes the key and checks the creator.
chatRoomSchema.pre('validate', function () {
  if (this.participants.length === 2) {
    const ids = this.participants.map((id) => id.toString());
    this.participantKey = buildParticipantKey(ids[0], ids[1]);

    if (this.createdBy && !ids.includes(this.createdBy.toString())) {
      throw new Error('createdBy must be one of the participants');
    }
  }
});

// "List my rooms, newest activity first". Works because "participants" is a multikey index.
chatRoomSchema.index({ participants: 1, lastMessageAt: -1 });

export const ChatRoom = model<IChatRoom>('ChatRoom', chatRoomSchema);