import crypto from 'node:crypto';
import * as argon2 from 'argon2';
import type { Types } from 'mongoose';
import type { VerifiedUpload } from '../middlewares/upload.middleware';
import { BlockedUser } from '../models/BlockedUser.model';
import { ChatRoom, buildParticipantKey } from '../models/ChatRoom.model';
import { EmailVerificationToken } from '../models/EmailVerificationToken.model';
import { Location } from '../models/Location.model';
import { Media, type IMedia } from '../models/Media.model';
import { Message } from '../models/Message.model';
import { Notification } from '../models/Notification.model';
import { PasswordResetToken } from '../models/PasswordResetToken.model';
import { PrivacySettings } from '../models/PrivacySettings.model';
import { RefreshToken } from '../models/RefreshToken.model';
import { Session } from '../models/Session.model';
import { User, type IUser } from '../models/User.model';
import { deleteFile, getAvatarUrl, uploadBuffer } from '../providers/storage.provider';
import type { UserRole } from '../types';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import type { UpdateProfileInput } from '../validators/user.validator';
import { isBlockedEitherWay } from './block.service';
import {
  getPrivacySettings,
  visiblePresence,
  type PrivacySettingsValues,
} from './privacy.service';

// ---------- DTOs: exactly what the API is allowed to expose ----------

/** The logged-in user's own profile. */
export interface SelfUserDTO {
  id: string;
  username: string;
  email: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  role: UserRole;
  emailVerified: boolean;
  createdAt: string;
}

/** What other people may see. No email, no role, and presence only if the user allows it. */
export interface PublicUserDTO {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  isOnline: boolean | null;
  lastSeenAt: string | null;
}

const SELF_FIELDS =
  'username email displayName bio avatarPublicId role status emailVerified createdAt deletedAt';
const PUBLIC_FIELDS =
  'username displayName bio avatarPublicId status deletedAt isOnline lastSeenAt';

export function toSelfUserDTO(
  user: Pick<
    IUser,
    '_id' | 'username' | 'email' | 'displayName' | 'bio' | 'avatarPublicId' | 'role' | 'emailVerified' | 'createdAt'
  >,
): SelfUserDTO {
  return {
    id: String(user._id),
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: getAvatarUrl(user.avatarPublicId),
    role: user.role,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toPublicUserDTO(
  user: Pick<IUser, '_id' | 'username' | 'displayName' | 'bio' | 'avatarPublicId' | 'isOnline' | 'lastSeenAt'>,
  settings: Pick<PrivacySettingsValues, 'showOnlineStatus' | 'showLastSeen'>,
): PublicUserDTO {
  return {
    id: String(user._id),
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: getAvatarUrl(user.avatarPublicId),
    ...visiblePresence(user, settings),
  };
}

// ---------- Reading profiles ----------

async function loadActiveUser(userId: string): Promise<IUser> {
  const user = await User.findById(userId).select(SELF_FIELDS).lean<IUser>();
  if (!user || user.deletedAt) throw ApiError.notFound('Account not found');
  return user;
}

export async function getMe(userId: string): Promise<SelfUserDTO> {
  return toSelfUserDTO(await loadActiveUser(userId));
}

/**
 * Another user's public profile. Rules:
 *  - banned/suspended/deleted accounts, and blocked users (either way), look like "not found"
 *  - ids are guessable, so you can only look up someone who opted in to discovery
 *    OR who already shares a chat room with you
 */
export async function getPublicProfile(viewerId: string, targetId: string): Promise<PublicUserDTO> {
  const target = await User.findById(targetId).select(PUBLIC_FIELDS).lean<IUser>();
  if (!target || target.deletedAt || target.status !== 'active') {
    throw ApiError.notFound('User not found');
  }

  if (viewerId !== targetId) {
    if (await isBlockedEitherWay(viewerId, targetId)) {
      throw ApiError.notFound('User not found');
    }
  }

  const settings = await getPrivacySettings(targetId);

  if (viewerId !== targetId && !settings.nearbyDiscoverable) {
    const sharedRoom = await ChatRoom.exists({ participantKey: buildParticipantKey(viewerId, targetId) });
    if (!sharedRoom) throw ApiError.notFound('User not found');
  }

  return toPublicUserDTO(target, settings);
}

// ---------- Editing the profile ----------

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<SelfUserDTO> {
  const changes: Partial<Pick<IUser, 'displayName' | 'bio'>> = {};
  if (input.displayName !== undefined) changes.displayName = input.displayName;
  if (input.bio !== undefined) changes.bio = input.bio;

  const user = await User.findOneAndUpdate(
    { _id: userId, deletedAt: null },
    { $set: changes },
    { new: true, runValidators: true },
  )
    .select(SELF_FIELDS)
    .lean<IUser>();

  if (!user) throw ApiError.notFound('Account not found');
  return toSelfUserDTO(user);
}

export async function updateAvatar(userId: string, file: VerifiedUpload): Promise<SelfUserDTO> {
  const current = await loadActiveUser(userId);

  const uploaded = await uploadBuffer({
    buffer: file.buffer,
    folder: 'avatars',
    resourceType: 'image',
    access: 'public',
  });

  const discardNewFile = (): Promise<void> =>
    deleteFile(uploaded.publicId, 'image', 'public').catch((err) =>
      logger.error({ err }, 'Could not remove an unused avatar file'),
    );

  let updated: IUser | null;
  try {
    updated = await User.findOneAndUpdate(
      { _id: userId, deletedAt: null },
      { $set: { avatarPublicId: uploaded.publicId } },
      { new: true },
    )
      .select(SELF_FIELDS)
      .lean<IUser>();
  } catch (err) {
    await discardNewFile();
    throw err;
  }

  if (!updated) {
    await discardNewFile();
    throw ApiError.notFound('Account not found');
  }

  if (current.avatarPublicId) {
    await deleteFile(current.avatarPublicId, 'image', 'public').catch((err) =>
      logger.error({ err }, 'Could not remove the previous avatar file'),
    );
  }
  return toSelfUserDTO(updated);
}

export async function removeAvatar(userId: string): Promise<SelfUserDTO> {
  const current = await loadActiveUser(userId);

  const updated = await User.findOneAndUpdate(
    { _id: userId, deletedAt: null },
    { $set: { avatarPublicId: null } },
    { new: true },
  )
    .select(SELF_FIELDS)
    .lean<IUser>();
  if (!updated) throw ApiError.notFound('Account not found');

  if (current.avatarPublicId) {
    await deleteFile(current.avatarPublicId, 'image', 'public').catch((err) =>
      logger.error({ err }, 'Could not remove the avatar file'),
    );
  }
  return toSelfUserDTO(updated);
}

// ---------- Deleting the account ----------

/** Removes the user's chat rooms, messages and media (files first, then records). */
async function purgeChatData(userId: string): Promise<void> {
  const rooms = await ChatRoom.find({ participants: userId }).select('_id').lean<{ _id: Types.ObjectId }[]>();
  const roomIds = rooms.map((room) => room._id);
  if (roomIds.length === 0) return;

  const mediaItems = await Media.find({ roomId: { $in: roomIds } })
    .select('storagePublicId storageResourceType')
    .lean<IMedia[]>();

  const deletedMediaIds: Types.ObjectId[] = [];
  for (const media of mediaItems) {
    try {
      await deleteFile(media.storagePublicId, media.storageResourceType, 'private');
      deletedMediaIds.push(media._id);
    } catch (err) {
      // The record stays, so the media cleanup job can retry later
      logger.error({ err, mediaId: String(media._id) }, 'Could not delete a media file during account deletion');
    }
  }

  await Media.deleteMany({ _id: { $in: deletedMediaIds } });
  await Message.deleteMany({ roomId: { $in: roomIds } });
  await ChatRoom.deleteMany({ _id: { $in: roomIds } });
}

/**
 * Deletes an account after re-checking the password.
 * The user record is ANONYMISED (not removed) so old reports and audit logs still point at something valid.
 * Everything personal is erased.
 */
export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await User.findOne({ _id: userId, deletedAt: null })
    .select('+passwordHash avatarPublicId')
    .lean<IUser>();
  if (!user) throw ApiError.notFound('Account not found');

  let passwordMatches = false;
  try {
    passwordMatches = await argon2.verify(user.passwordHash, password);
  } catch {
    passwordMatches = false;
  }
  if (!passwordMatches) {
    // 403 (not 401) so a client never mistakes this for an expired login and signs the user out
    throw ApiError.forbidden('Incorrect password', { code: 'INVALID_PASSWORD' });
  }

  const id = String(user._id);

  // Step 1: anonymise first, so the account can no longer be used even if later steps fail
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        username: `del_${id}`,
        email: `deleted-${id}@deleted.invalid`,
        displayName: 'Deleted user',
        bio: '',
        avatarPublicId: null,
        passwordHash: `deleted:${crypto.randomBytes(32).toString('hex')}`,
        role: 'user',
        statusReason: null,
        emailVerified: false,
        emailVerifiedAt: null,
        isOnline: false,
        failedLoginAttempts: 0,
        lockUntil: null,
        deletedAt: new Date(),
      },
    },
  );

  // Step 2: erase everything personal. Each step is independent: one failure doesn't stop the rest.
  const steps = [
    'sessions',
    'refresh tokens',
    'password reset tokens',
    'email verification tokens',
    'location',
    'privacy settings',
    'notifications',
    'blocks',
  ];
  const results = await Promise.allSettled([
    Session.deleteMany({ userId: user._id }).exec(),
    RefreshToken.deleteMany({ userId: user._id }).exec(),
    PasswordResetToken.deleteMany({ userId: user._id }).exec(),
    EmailVerificationToken.deleteMany({ userId: user._id }).exec(),
    Location.deleteOne({ userId: user._id }).exec(),
    PrivacySettings.deleteOne({ userId: user._id }).exec(),
    Notification.deleteMany({ userId: user._id }).exec(),
    BlockedUser.deleteMany({ $or: [{ blockerId: user._id }, { blockedId: user._id }] }).exec(),
  ]);
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason, step: steps[index] }, 'Account cleanup step failed');
    }
  });

  await purgeChatData(id).catch((err) => logger.error({ err }, 'Chat data cleanup failed during account deletion'));

  if (user.avatarPublicId) {
    await deleteFile(user.avatarPublicId, 'image', 'public').catch((err) =>
      logger.error({ err }, 'Could not remove avatar during account deletion'),
    );
  }
}