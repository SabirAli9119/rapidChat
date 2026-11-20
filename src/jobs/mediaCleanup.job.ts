import { deleteExpiredMedia } from '../services/media.service';

export const MEDIA_BATCH_SIZE = 100;
export const MEDIA_MAX_BATCHES = 20;

/**
 * Deletes expired files: storage FIRST, the database record SECOND (see deleteExpiredMedia).
 * A file that cannot be deleted keeps its record, so the next run tries again.
 */
export async function runMediaCleanup(): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;

  for (let batch = 0; batch < MEDIA_MAX_BATCHES; batch++) {
    const result = await deleteExpiredMedia(MEDIA_BATCH_SIZE);
    deleted += result.deleted;
    failed += result.failed;

    if (result.deleted + result.failed < MEDIA_BATCH_SIZE) break; // nothing more is waiting
    // The whole batch failed (storage is probably down). The next batch would pick the same files.
    if (result.deleted === 0) break;
  }
  return { deleted, failed };
}