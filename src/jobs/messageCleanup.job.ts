import { expireMessages } from '../services/message.service';
import { emitMessageExpired } from '../sockets';

/** Messages deleted per database round trip. */
export const MESSAGE_BATCH_SIZE = 500;
/** One run handles at most BATCH_SIZE x MAX_BATCHES messages. A bigger backlog continues on the next run. */
export const MESSAGE_MAX_BATCHES = 20;

/**
 * Deletes messages whose 30 minutes are up and tells connected clients to remove them.
 * Reads already hide expired messages, so this only keeps the database tidy and informs open apps.
 */
export async function runMessageCleanup(): Promise<{ removed: number }> {
  let removed = 0;

  for (let batch = 0; batch < MESSAGE_MAX_BATCHES; batch++) {
    const expired = await expireMessages(MESSAGE_BATCH_SIZE);
    if (expired.length === 0) break;

    removed += expired.length;
    await emitMessageExpired(expired); // never throws; does nothing when no socket server runs in this process
    if (expired.length < MESSAGE_BATCH_SIZE) break;
  }
  return { removed };
}