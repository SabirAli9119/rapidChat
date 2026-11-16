import { Types } from 'mongoose';
import { ChatRoom, buildParticipantKey, type IChatRoom } from '../models/ChatRoom.model';
import { User, type IUser } from '../models/User.model';
import type { PageResult } from '../types';
import { ApiError } from '../utils/ApiError';
import { buildPageResult, isDuplicateKeyError, skipFor } from '../utils/db';
import { assertNotBlocked, getBlockedUserIds } from './block.service';
import { areNearby } from './nearby.service';
import { DEFAULT_PRIVACY, getPrivacySettings, getPrivacySettingsMap } from './privacy.service';
import { toPublicUserDTO, type PublicUserDTO } from './user.service';

export interface RoomDTO {
  id: string;
  /** The OTHER person in this private chat */
  participant: PublicUserDTO;
  lastMessageAt: string;
  createdAt: string;
}

export interface RoomAccess {
  room: IChatRoom;
  otherUserId: string;
}

const PARTICIPANT_FIELDS = 'username displayName bio avatarPublicId isOnline lastSeenAt';

// ---------- Small helpers ----------

export function isParticipant(room: Pick<IChatRoom, 'participants'>, userId: string): boolean {
  return room.participants.some((id) => id.toString() === userId);
}

export function getOtherParticipantId(room: Pick<IChatRoom, 'participants'>, userId: string): string | null {
  const other = room.participants.find((id) => id.toString() !== userId);
  return other ? other.toString() : null;
}

/** Cheap membership check (no block check). Used when a user leaves a room over a socket. */
export async function isRoomMember(roomId: string, userId: string): Promise<boolean> {
  return (await ChatRoom.exists({ _id: roomId, participants: userId })) !== null;
}

// ---------- Access control (used by messages, media and sockets) ----------

/**
 * THE gatekeeper for everything inside a room. Throws unless:
 *  - the room exists and the user is one of its two participants
 *  - neither participant has blocked the other
 *  - the other person's account is still active
 * "Not a member" and "room does not exist" give the same 404, so room ids reveal nothing.
 */
export async function assertRoomAccess(roomId: string, userId: string): Promise<RoomAccess> {
  const room = await ChatRoom.findOne({ _id: roomId, participants: userId }).lean<IChatRoom>();
  const otherUserId = room ? getOtherParticipantId(room, userId) : null;
  if (!room || !otherUserId) {
    throw ApiError.notFound('Room not found', { code: 'ROOM_NOT_FOUND' });
  }

  await assertNotBlocked(userId, otherUserId);

  const other = await User.findById(otherUserId).select('status deletedAt').lean<Pick<IUser, 'status' | 'deletedAt'>>();
  if (!other || other.deletedAt || other.status !== 'active') {
    throw ApiError.forbidden('This user is no longer available', { code: 'USER_UNAVAILABLE' });
  }

  return { room, otherUserId };
}

/** Moves a room up the list. $max means an older timestamp can never move it back down. */
export async function touchRoom(roomId: string, at: Date): Promise<void> {
  await ChatRoom.updateOne({ _id: roomId }, { $max: { lastMessageAt: at } });
}

// ---------- DTOs ----------

async function buildRoomDTOs(rooms: IChatRoom[], viewerId: string): Promise<RoomDTO[]> {
  const otherIds = rooms
    .map((room) => getOtherParticipantId(room, viewerId))
    .filter((id): id is string => id !== null);

  const [users, settings] = await Promise.all([
    User.find({ _id: { $in: otherIds }, status: 'active', deletedAt: null })
      .select(PARTICIPANT_FIELDS)
      .lean<IUser[]>(),
    getPrivacySettingsMap(otherIds),
  ]);
  const usersById = new Map(users.map((user) => [String(user._id), user]));

  const dtos: RoomDTO[] = [];
  for (const room of rooms) {
    const otherId = getOtherParticipantId(room, viewerId);
    const other = otherId ? usersById.get(otherId) : undefined;
    if (!otherId || !other) continue; // banned or deleted: the room is hidden from the list

    dtos.push({
      id: String(room._id),
      participant: toPublicUserDTO(other, settings.get(otherId) ?? DEFAULT_PRIVACY),
      lastMessageAt: room.lastMessageAt.toISOString(),
      createdAt: room.createdAt.toISOString(),
    });
  }
  return dtos;
}

// ---------- Rooms ----------

/**
 * Starts a private chat with someone, or returns the existing one (one room per pair, always).
 * Starting a NEW chat has extra rules (existing chats continue regardless):
 *   both people must be sharing a fresh location within range of each other,
 *   and the other person must accept new chats.
 */
export async function createOrGetRoom(
  userId: string,
  otherUserId: string,
): Promise<{ room: RoomDTO; created: boolean }> {
  if (userId === otherUserId) {
    throw ApiError.badRequest('You cannot start a chat with yourself', { code: 'CHAT_WITH_SELF' });
  }

  const other = await User.findById(otherUserId).select('status deletedAt').lean<Pick<IUser, 'status' | 'deletedAt'>>();
  if (!other || other.deletedAt || other.status !== 'active') {
    throw ApiError.notFound('User not found');
  }

  await assertNotBlocked(userId, otherUserId);

  const participantKey = buildParticipantKey(userId, otherUserId);
  let room = await ChatRoom.findOne({ participantKey }).lean<IChatRoom>();
  let created = false;

  if (!room) {
    if (!(await areNearby(userId, otherUserId))) {
      throw ApiError.forbidden('You can only start a chat with people who are nearby', { code: 'NOT_NEARBY' });
    }
    const theirSettings = await getPrivacySettings(otherUserId);
    if (!theirSettings.allowNewChats) {
      throw ApiError.forbidden('This user is not accepting new chats', { code: 'CHAT_NOT_ALLOWED' });
    }

    try {
      const doc = await ChatRoom.create({ participants: [userId, otherUserId], createdBy: userId });
      room = doc.toObject() as IChatRoom;
      created = true;
    } catch (err) {
      // Two people opened a chat with each other at the same instant: the unique index let only one win
      if (!isDuplicateKeyError(err)) throw err;
      room = await ChatRoom.findOne({ participantKey }).lean<IChatRoom>();
    }
  }

  if (!room) throw ApiError.internal('Could not create the chat room');

  const [dto] = await buildRoomDTOs([room], userId);
  if (!dto) throw ApiError.notFound('User not found');
  return { room: dto, created };
}

export async function getRoom(userId: string, roomId: string): Promise<RoomDTO> {
  const { room } = await assertRoomAccess(roomId, userId);
  const [dto] = await buildRoomDTOs([room], userId);
  if (!dto) throw ApiError.notFound('Room not found', { code: 'ROOM_NOT_FOUND' });
  return dto;
}

/** My rooms, most recent activity first. Rooms with someone I blocked (or who blocked me) are hidden. */
export async function listRooms(
  userId: string,
  options: { page: number; limit: number },
): Promise<PageResult<RoomDTO>> {
  const { page, limit } = options;
  const blockedIds = await getBlockedUserIds(userId);

  const filter = {
    $and: [{ participants: new Types.ObjectId(userId) }, { participants: { $nin: blockedIds } }],
  };

  const [rooms, total] = await Promise.all([
    ChatRoom.find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .lean<IChatRoom[]>(),
    ChatRoom.countDocuments(filter),
  ]);

  return buildPageResult(await buildRoomDTOs(rooms, userId), total, page, limit);
}