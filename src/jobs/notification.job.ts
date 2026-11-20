import { deleteExpiredNotifications } from '../services/notification.service';

/**
 * Removes expired notifications. "New message" notifications expire with their message (30 minutes),
 * everything else after 7 days. Expired ones are already hidden from every list.
 */
export async function runNotificationCleanup(): Promise<{ removed: number }> {
  return { removed: await deleteExpiredNotifications() };
}