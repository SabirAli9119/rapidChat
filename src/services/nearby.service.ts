import { Types, type PipelineStage } from 'mongoose';
import { env } from '../config/env';
import { Location, type ILocation } from '../models/Location.model';
import { PrivacySettings } from '../models/PrivacySettings.model';
import type { IUser } from '../models/User.model';
import { User } from '../models/User.model';
import { getAvatarUrl } from '../providers/storage.provider';
import type { PageResult } from '../types';
import { ApiError } from '../utils/ApiError';
import { buildPageResult, skipFor } from '../utils/db';
import {
  approximateDistance,
  coarsenCoordinates,
  haversineDistanceKm,
  isValidCoordinates,
  kmToMeters,
  toGeoJsonPoint,
  type Coordinates,
} from '../utils/geo';
import type { SearchNearbyInput, UpdateLocationInput } from '../validators/nearby.validator';
import { getBlockedUserIds } from './block.service';
import { getPrivacySettings, getPrivacySettingsMap, visiblePresence } from './privacy.service';

const MINUTE_MS = 60 * 1000;

/** One person in the nearby results. Note: NO coordinates, only a rounded distance bucket. */
export interface NearbyUserDTO {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  distance: { bucketKm: number; label: string };
  isOnline: boolean | null;
  lastSeenAt: string | null;
  /** False means this person does not accept chats from new people */
  allowsNewChats: boolean;
}

export interface LocationStatusDTO {
  sharing: boolean;
  expiresAt: string | null;
}

interface NearbyRow {
  distanceMeters: number;
  user: Pick<IUser, '_id' | 'username' | 'displayName' | 'bio' | 'avatarPublicId' | 'isOnline' | 'lastSeenAt'>;
  privacy: { showOnlineStatus: boolean; showLastSeen: boolean; allowNewChats: boolean };
}

async function assertDiscoverable(userId: string): Promise<void> {
  const settings = await getPrivacySettings(userId);
  if (!settings.nearbyDiscoverable) {
    throw ApiError.forbidden('Turn on nearby discovery in your privacy settings first', {
      code: 'DISCOVERY_DISABLED',
    });
  }
}

const toCoordinates = (location: ILocation['location']): Coordinates => ({
  longitude: location.coordinates[0],
  latitude: location.coordinates[1],
});

// ---------- Sharing your location ----------

/**
 * Stores the user's latest position. Only allowed after they opted in to discovery.
 * The position is coarsened (about 110 m grid) BEFORE it is stored, so the precise
 * point never reaches the database. It expires automatically after LOCATION_RETENTION_MINUTES.
 */
export async function updateLocation(userId: string, input: UpdateLocationInput): Promise<LocationStatusDTO> {
  if (!isValidCoordinates(input)) {
    throw ApiError.badRequest('Invalid coordinates', { code: 'INVALID_COORDINATES' });
  }
  await assertDiscoverable(userId);

  const expiresAt = new Date(Date.now() + env.LOCATION_RETENTION_MINUTES * MINUTE_MS);

  await Location.findOneAndUpdate(
    { userId },
    { $set: { location: toGeoJsonPoint(coarsenCoordinates(input)), expiresAt } },
    { upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );

  // Deliberately not echoing the coordinates back
  return { sharing: true, expiresAt: expiresAt.toISOString() };
}

export async function getLocationStatus(userId: string): Promise<LocationStatusDTO> {
  const doc = await Location.findOne({ userId, expiresAt: { $gt: new Date() } })
    .select('expiresAt')
    .lean<Pick<ILocation, 'expiresAt'>>();
  return { sharing: Boolean(doc), expiresAt: doc ? doc.expiresAt.toISOString() : null };
}

/** "Stop sharing now": deletes the stored location immediately. */
export async function removeLocation(userId: string): Promise<void> {
  await Location.deleteOne({ userId });
}

// ---------- Searching ----------

function toNearbyDTO(row: NearbyRow): NearbyUserDTO {
  return {
    id: String(row.user._id),
    username: row.user.username,
    displayName: row.user.displayName,
    bio: row.user.bio,
    avatarUrl: getAvatarUrl(row.user.avatarPublicId),
    distance: approximateDistance(row.distanceMeters / 1000),
    ...visiblePresence(
      { isOnline: row.user.isOnline, lastSeenAt: row.user.lastSeenAt ?? null },
      row.privacy,
    ),
    allowsNewChats: row.privacy.allowNewChats,
  };
}

/**
 * People within `radiusKm` of the caller, nearest first.
 * To search you must be discoverable yourself (you cannot watch others without being visible).
 */
export async function searchNearby(
  userId: string,
  input: SearchNearbyInput,
): Promise<PageResult<NearbyUserDTO>> {
  await assertDiscoverable(userId);

  const mine = await Location.findOne({ userId, expiresAt: { $gt: new Date() } })
    .select('location')
    .lean<Pick<ILocation, 'location'>>();
  if (!mine) {
    throw ApiError.badRequest('Share your location first', { code: 'LOCATION_REQUIRED' });
  }

  const { page, limit } = input;
  const radiusKm = Math.min(input.radiusKm, env.NEARBY_MAX_RADIUS_KM); // hard cap, even if a caller bypasses validation
  const self = new Types.ObjectId(userId);
  const excluded = [...(await getBlockedUserIds(userId)), self];

  const pipeline: PipelineStage[] = [
    // Must be the first stage. Uses the 2dsphere index, returns nearest first.
    {
      $geoNear: {
        near: { type: 'Point', coordinates: mine.location.coordinates },
        distanceField: 'distanceMeters',
        maxDistance: kmToMeters(radiusKm),
        spherical: true,
        query: { userId: { $nin: excluded }, expiresAt: { $gt: new Date() } },
      },
    },
    // Only active accounts
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    { $match: { 'user.status': 'active', 'user.deletedAt': null } },
    // Re-check the opt-in. A user with no privacy record never opted in, so they are dropped.
    {
      $lookup: {
        from: PrivacySettings.collection.name,
        localField: 'userId',
        foreignField: 'userId',
        as: 'privacy',
      },
    },
    { $unwind: '$privacy' },
    { $match: { 'privacy.nearbyDiscoverable': true } },
    { $sort: { distanceMeters: 1, 'user._id': 1 } },
    {
      $facet: {
        items: [
          { $skip: skipFor(page, limit) },
          { $limit: limit },
          // Whitelist: the location field and exact coordinates are never selected
          {
            $project: {
              _id: 0,
              distanceMeters: 1,
              'user._id': 1,
              'user.username': 1,
              'user.displayName': 1,
              'user.bio': 1,
              'user.avatarPublicId': 1,
              'user.isOnline': 1,
              'user.lastSeenAt': 1,
              'privacy.showOnlineStatus': 1,
              'privacy.showLastSeen': 1,
              'privacy.allowNewChats': 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ];

  const [facet] = await Location.aggregate<{ items: NearbyRow[]; total: { count: number }[] }>(pipeline);
  const total = facet?.total[0]?.count ?? 0;
  const items = (facet?.items ?? []).map(toNearbyDTO);

  return buildPageResult(items, total, page, limit);
}

// ---------- Used by chat.service ----------

/**
 * True when BOTH users are discoverable, both have a fresh location,
 * and those locations are within the maximum discovery radius of each other.
 */
export async function areNearby(userA: string, userB: string): Promise<boolean> {
  const rows = await Location.find({ userId: { $in: [userA, userB] }, expiresAt: { $gt: new Date() } })
    .select('userId location')
    .lean<Pick<ILocation, 'userId' | 'location'>[]>();
  if (rows.length !== 2) return false;

  const settings = await getPrivacySettingsMap([userA, userB]);
  if (!settings.get(userA)?.nearbyDiscoverable || !settings.get(userB)?.nearbyDiscoverable) return false;

  const distanceKm = haversineDistanceKm(toCoordinates(rows[0].location), toCoordinates(rows[1].location));
  return distanceKm <= env.NEARBY_MAX_RADIUS_KM;
}