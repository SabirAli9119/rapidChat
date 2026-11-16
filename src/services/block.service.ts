import { Types } from 'mongoose';
import { BlockedUser, type IBlockedUser } from '../models/BlockedUser.model';
import { User, type IUser } from '../models/User.model';
import { getAvatarUrl } from '../providers/storage.provider';
import type { PageResult } from '../types';
import { ApiError } from '../utils/ApiError';
import { buildPageResult, isDuplicateKeyError, skipFor } from '../utils/db';

export interface BlockedUserDTO {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  blockedAt: string;
}

/** Blocks a user. Blocking someone who is already blocked is not an error. */
export async function blockUser(blockerId: string, targetId: string): Promise<void> {
  if (blockerId === targetId) {
    throw ApiError.badRequest('You cannot block yourself');
  }

  const target = await User.exists({ _id: targetId, deletedAt: null });
  if (!target) throw ApiError.notFound('User not found');

  try {
    await BlockedUser.create({ blockerId, blockedId: targetId });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err; // already blocked: fine
  }
}

export async function unblockUser(blockerId: string, targetId: string): Promise<void> {
  const result = await BlockedUser.deleteOne({ blockerId, blockedId: targetId });
  if (result.deletedCount === 0) {
    throw ApiError.notFound('You have not blocked this user');
  }
}

export async function listBlockedUsers(
  blockerId: string,
  options: { page: number; limit: number },
): Promise<PageResult<BlockedUserDTO>> {
  const { page, limit } = options;

  const [blocks, total] = await Promise.all([
    BlockedUser.find({ blockerId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skipFor(page, limit))
      .limit(limit)
      .lean<IBlockedUser[]>(),
    BlockedUser.countDocuments({ blockerId }),
  ]);

  const users = await User.find({ _id: { $in: blocks.map((b) => b.blockedId) } })
    .select('username displayName avatarPublicId')
    .lean<IUser[]>();
  const usersById = new Map(users.map((u) => [String(u._id), u]));

  const items: BlockedUserDTO[] = [];
  for (const block of blocks) {
    const user = usersById.get(String(block.blockedId));
    if (!user) continue; // account no longer exists
    items.push({
      userId: String(user._id),
      username: user.username,
      displayName: user.displayName,
      avatarUrl: getAvatarUrl(user.avatarPublicId),
      blockedAt: block.createdAt.toISOString(),
    });
  }

  return buildPageResult(items, total, page, limit);
}

/** True if EITHER user has blocked the other. */
export async function isBlockedEitherWay(userA: string, userB: string): Promise<boolean> {
  const found = await BlockedUser.exists({
    $or: [
      { blockerId: userA, blockedId: userB },
      { blockerId: userB, blockedId: userA },
    ],
  });
  return found !== null;
}

/**
 * Throws if either user blocked the other. The message is deliberately generic:
 * it must not reveal to a blocked person that they were blocked.
 */
export async function assertNotBlocked(userA: string, userB: string): Promise<void> {
  if (await isBlockedEitherWay(userA, userB)) {
    throw ApiError.forbidden('You cannot interact with this user', { code: 'INTERACTION_NOT_ALLOWED' });
  }
}

/** Everyone who has blocked this user, or whom this user has blocked. Used to filter nearby results. */
export async function getBlockedUserIds(userId: string): Promise<Types.ObjectId[]> {
  const rows = await BlockedUser.find({ $or: [{ blockerId: userId }, { blockedId: userId }] })
    .select('blockerId blockedId')
    .lean<Pick<IBlockedUser, 'blockerId' | 'blockedId'>[]>();

  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(String(row.blockerId));
    ids.add(String(row.blockedId));
  }
  ids.delete(userId);

  return [...ids].map((id) => new Types.ObjectId(id));
}