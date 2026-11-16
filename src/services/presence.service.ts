import { redis } from '../config/redis';
import { User } from '../models/User.model';

const KEY_PREFIX = 'presence:sockets:';
/** Safety net: a stale key from a crash disappears after a day. */
const KEY_TTL_SECONDS = 24 * 60 * 60;

const keyFor = (userId: string): string => `${KEY_PREFIX}${userId}`;

/** Reads one numeric result out of a Redis MULTI/EXEC response. */
function numberAt(results: [Error | null, unknown][] | null, index: number): number {
  const entry = results?.[index];
  if (!entry) throw new Error('Redis transaction failed');
  if (entry[0]) throw entry[0];
  return Number(entry[1]);
}

/** Call when a socket connects. cameOnline is true only for the user's FIRST live socket. */
export async function userConnected(userId: string, socketId: string): Promise<{ cameOnline: boolean }> {
  const key = keyFor(userId);
  const results = await redis.multi().sadd(key, socketId).scard(key).expire(key, KEY_TTL_SECONDS).exec();

  const added = numberAt(results, 0);
  const count = numberAt(results, 1);
  const cameOnline = added === 1 && count === 1;

  if (cameOnline) {
    await User.updateOne({ _id: userId }, { $set: { isOnline: true } });
  }
  return { cameOnline };
}

/** Call when a socket disconnects. wentOffline is true only when the LAST socket is gone. */
export async function userDisconnected(
  userId: string,
  socketId: string,
): Promise<{ wentOffline: boolean; lastSeenAt: Date | null }> {
  const key = keyFor(userId);
  const results = await redis.multi().srem(key, socketId).scard(key).exec();

  const removed = numberAt(results, 0);
  const remaining = numberAt(results, 1);

  if (removed === 1 && remaining === 0) {
    const lastSeenAt = new Date();
    await User.updateOne({ _id: userId }, { $set: { isOnline: false, lastSeenAt } });
    return { wentOffline: true, lastSeenAt };
  }
  return { wentOffline: false, lastSeenAt: null };
}

export async function isUserOnline(userId: string): Promise<boolean> {
  return (await redis.scard(keyFor(userId))) > 0;
}

/**
 * Called once when the server starts. If the server crashed, nobody is really connected
 * anymore, so every "online" flag is stale. Assumes ONE server instance (see limitations).
 */
export async function resetPresence(): Promise<void> {
  const stream = redis.scanStream({ match: `${KEY_PREFIX}*`, count: 100 }) as AsyncIterable<string[]>;
  for await (const keys of stream) {
    if (keys.length > 0) await redis.del(...keys);
  }
  await User.updateMany({ isOnline: true }, { $set: { isOnline: false } });
}