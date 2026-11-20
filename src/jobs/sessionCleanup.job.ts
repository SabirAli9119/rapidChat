import type { Types } from 'mongoose';
import { EmailVerificationToken } from '../models/EmailVerificationToken.model';
import { PasswordResetToken } from '../models/PasswordResetToken.model';
import { RefreshToken } from '../models/RefreshToken.model';
import { Session } from '../models/Session.model';

export const SESSION_BATCH_SIZE = 1000;
export const SESSION_MAX_BATCHES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Logged-out sessions are kept this long, then removed. */
export const REVOKED_SESSION_RETENTION_MS = DAY_MS;
/** A used password-reset link is kept this long, then removed. */
export const USED_RESET_TOKEN_RETENTION_MS = DAY_MS;

/**
 * Removes finished sessions and the tokens that belong to them.
 * Access is already refused for all of these (every check looks at expiresAt and revokedAt),
 * so this only reclaims space. The database's TTL indexes do part of it as well.
 */
export async function runSessionCleanup(): Promise<{
  sessions: number;
  refreshTokens: number;
  passwordResetTokens: number;
  emailVerificationTokens: number;
}> {
  const now = new Date();
  const revokedCutoff = new Date(now.getTime() - REVOKED_SESSION_RETENTION_MS);
  const usedCutoff = new Date(now.getTime() - USED_RESET_TOKEN_RETENTION_MS);

  const ended = { $or: [{ expiresAt: { $lte: now } }, { revokedAt: { $lte: revokedCutoff } }] };

  let sessions = 0;
  let refreshTokens = 0;

  for (let batch = 0; batch < SESSION_MAX_BATCHES; batch++) {
    const found = await Session.find(ended)
      .select('_id')
      .limit(SESSION_BATCH_SIZE)
      .lean<{ _id: Types.ObjectId }[]>();
    if (found.length === 0) break;
    const ids = found.map((session) => session._id);

    // The "ended" condition is repeated, so a session refreshed in the meantime is never removed
    const removed = await Session.deleteMany({ _id: { $in: ids }, ...ended });
    sessions += removed.deletedCount;

    // Tokens are removed only for sessions that are really gone
    const survivors = await Session.find({ _id: { $in: ids } })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>();
    const alive = new Set(survivors.map((session) => String(session._id)));
    const goneIds = ids.filter((id) => !alive.has(String(id)));
    if (goneIds.length > 0) {
      const tokens = await RefreshToken.deleteMany({ sessionId: { $in: goneIds } });
      refreshTokens += tokens.deletedCount;
    }

    if (found.length < SESSION_BATCH_SIZE || removed.deletedCount === 0) break;
  }

  // Old tokens of sessions that are still alive (the session continues with newer tokens)
  refreshTokens += (await RefreshToken.deleteMany({ expiresAt: { $lte: now } })).deletedCount;

  const passwordResetTokens = (
    await PasswordResetToken.deleteMany({
      $or: [{ expiresAt: { $lte: now } }, { usedAt: { $lte: usedCutoff } }],
    })
  ).deletedCount;

  const emailVerificationTokens = (await EmailVerificationToken.deleteMany({ expiresAt: { $lte: now } }))
    .deletedCount;

  return { sessions, refreshTokens, passwordResetTokens, emailVerificationTokens };
}