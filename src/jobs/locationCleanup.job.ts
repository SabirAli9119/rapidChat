import type { Types } from 'mongoose';
import { Location } from '../models/Location.model';
import { PrivacySettings } from '../models/PrivacySettings.model';
import { User } from '../models/User.model';

export const LOCATION_BATCH_SIZE = 1000;
export const LOCATION_MAX_BATCHES = 20;

/**
 * Privacy sweep. Removes:
 *  - expired locations (the database's TTL index does this too, but only about once a minute)
 *  - "orphaned" locations: the owner is banned, suspended, deleted, no longer exists, or has not
 *    opted in to discovery. These should never exist; this is the safety net if some code path misses one.
 */
export async function runLocationCleanup(): Promise<{ expired: number; orphaned: number }> {
  const startedAt = new Date();

  const expired = await Location.deleteMany({ expiresAt: { $lte: startedAt } });
  let orphaned = 0;

  for (let batch = 0; batch < LOCATION_MAX_BATCHES; batch++) {
    const stale = await Location.aggregate<{ _id: Types.ObjectId }>([
      { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'user' } },
      // Flatten the lookup result. With preserveNullAndEmptyArrays, a missing owner leaves NO "user" field.
      // (Paths like "user.0.field" are avoided on purpose: MongoDB treats a missing value as null there.)
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: PrivacySettings.collection.name,
          localField: 'userId',
          foreignField: 'userId',
          as: 'privacy',
        },
      },
      { $unwind: { path: '$privacy', preserveNullAndEmptyArrays: true } },
      {
        $match: {
          $or: [
            { user: { $exists: false } }, // the account no longer exists
            { 'user.status': { $ne: 'active' } }, // banned or suspended
            { 'user.deletedAt': { $ne: null } }, // deleted
            { privacy: { $exists: false } }, // never opted in (no privacy record)
            { 'privacy.nearbyDiscoverable': { $ne: true } }, // opted out
          ],
        },
      },
      { $limit: LOCATION_BATCH_SIZE },
      { $project: { _id: 1 } },
    ]);
    if (stale.length === 0) break;

    // updatedAt guard: a location refreshed after this run started is left alone
    const removed = await Location.deleteMany({
      _id: { $in: stale.map((row) => row._id) },
      updatedAt: { $lte: startedAt },
    });
    orphaned += removed.deletedCount;

    if (stale.length < LOCATION_BATCH_SIZE || removed.deletedCount === 0) break;
  }

  return { expired: expired.deletedCount, orphaned };
}