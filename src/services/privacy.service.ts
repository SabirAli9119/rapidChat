import { Location } from '../models/Location.model';
import { PrivacySettings, type IPrivacySettings } from '../models/PrivacySettings.model';
import type { UpdatePrivacyInput } from '../validators/user.validator';

export interface PrivacySettingsValues {
  nearbyDiscoverable: boolean;
  showOnlineStatus: boolean;
  showLastSeen: boolean;
  allowNewChats: boolean;
}

/** What a user has before they ever change anything: privacy-first. */
export const DEFAULT_PRIVACY: PrivacySettingsValues = {
  nearbyDiscoverable: false,
  showOnlineStatus: true,
  showLastSeen: false,
  allowNewChats: true,
};

const PRIVACY_KEYS = ['nearbyDiscoverable', 'showOnlineStatus', 'showLastSeen', 'allowNewChats'] as const;

function toValues(doc: IPrivacySettings): PrivacySettingsValues {
  return {
    nearbyDiscoverable: doc.nearbyDiscoverable,
    showOnlineStatus: doc.showOnlineStatus,
    showLastSeen: doc.showLastSeen,
    allowNewChats: doc.allowNewChats,
  };
}

/** Reading never creates a record. A user with no record simply has the defaults. */
export async function getPrivacySettings(userId: string): Promise<PrivacySettingsValues> {
  const doc = await PrivacySettings.findOne({ userId }).lean<IPrivacySettings>();
  return doc ? toValues(doc) : { ...DEFAULT_PRIVACY };
}

/** Settings for many users at once. Every requested id gets an entry. */
export async function getPrivacySettingsMap(
  userIds: string[],
): Promise<Map<string, PrivacySettingsValues>> {
  const docs = await PrivacySettings.find({ userId: { $in: userIds } }).lean<IPrivacySettings[]>();
  const map = new Map<string, PrivacySettingsValues>();
  for (const id of userIds) map.set(id, { ...DEFAULT_PRIVACY });
  for (const doc of docs) map.set(String(doc.userId), toValues(doc));
  return map;
}

export async function updatePrivacySettings(
  userId: string,
  input: UpdatePrivacyInput,
): Promise<PrivacySettingsValues> {
  const changes: Partial<PrivacySettingsValues> = {};
  for (const key of PRIVACY_KEYS) {
    const value = input[key];
    if (value !== undefined) changes[key] = value;
  }

  const doc = await PrivacySettings.findOneAndUpdate(
    { userId },
    { $set: changes },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean<IPrivacySettings>();

  // Opting out of discovery must not leave a stored location behind
  if (changes.nearbyDiscoverable === false) {
    await Location.deleteOne({ userId });
  }

  return doc ? toValues(doc) : { ...DEFAULT_PRIVACY, ...changes };
}

/**
 * Applies a user's presence privacy for someone ELSE looking at them.
 * null means "hidden", which is different from "offline".
 */
export function visiblePresence(
  user: { isOnline: boolean; lastSeenAt: Date | null },
  settings: Pick<PrivacySettingsValues, 'showOnlineStatus' | 'showLastSeen'>,
): { isOnline: boolean | null; lastSeenAt: string | null } {
  return {
    isOnline: settings.showOnlineStatus ? user.isOnline : null,
    lastSeenAt: settings.showLastSeen && user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
  };
}