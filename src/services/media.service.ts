import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import type { VerifiedUpload } from '../middlewares/upload.middleware';
import { MAX_MEDIA_SIZE_BYTES, Media, type IMedia } from '../models/Media.model';
import { User } from '../models/User.model';
import { deleteFile, openPrivateFile, uploadBuffer } from '../providers/storage.provider';
import type { MediaDTO, MediaKind } from '../types';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { safeEqual } from '../utils/token';
import { assertRoomAccess } from './chat.service';

/** Uploaded-but-not-yet-sent files a user may have at once. Limits storage abuse. */
const MAX_PENDING_UPLOADS = 10;

export interface MediaFile {
  stream: Readable;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  kind: MediaKind;
}

/** What clients may see about a file: no URL and no storage id. Files are fetched through the API. */
export function toMediaDTO(
  media: Pick<IMedia, '_id' | 'kind' | 'mimeType' | 'sizeBytes' | 'originalName' | 'expiresAt'>,
): MediaDTO {
  return {
    id: String(media._id),
    kind: media.kind,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    originalName: media.originalName,
    expiresAt: media.expiresAt.toISOString(),
  };
}

// ---------- Upload ----------

/**
 * Stores a verified file in PRIVATE storage and records it as "pending".
 * It becomes part of the chat only when it is attached to a message (see claimMediaForMessage).
 * If nobody sends it within MESSAGE_EXPIRY_MINUTES, it expires and the cleanup job deletes it.
 */
export async function uploadMedia(userId: string, roomId: string, file: VerifiedUpload): Promise<MediaDTO> {
  await assertRoomAccess(roomId, userId); // member, not blocked, other user active

  const maxBytes = Math.min(env.MAX_FILE_SIZE_MB * 1024 * 1024, MAX_MEDIA_SIZE_BYTES);
  if (file.sizeBytes > maxBytes) {
    throw ApiError.payloadTooLarge('File is too large', { code: 'FILE_TOO_LARGE' });
  }

  const pending = await Media.countDocuments({
    uploaderId: userId,
    status: 'pending',
    expiresAt: { $gt: new Date() },
  });
  if (pending >= MAX_PENDING_UPLOADS) {
    throw ApiError.tooManyRequests('You have too many unsent files. Send or wait for them to expire.', {
      code: 'TOO_MANY_PENDING_UPLOADS',
    });
  }

  const stored = await uploadBuffer({
    buffer: file.buffer,
    folder: 'chat-media',
    resourceType: file.storageResourceType,
    access: 'private',
  });

  try {
    const doc = await Media.create({
      uploaderId: userId,
      roomId,
      kind: file.kind,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      originalName: file.originalName,
      storagePublicId: stored.publicId,
      storageResourceType: file.storageResourceType,
    });
    return toMediaDTO(doc.toObject() as IMedia);
  } catch (err) {
    // Never leave a file in storage that the database does not know about
    await deleteFile(stored.publicId, file.storageResourceType, 'private').catch((deleteErr) =>
      logger.error({ err: deleteErr }, 'Could not remove an orphaned upload'),
    );
    throw err;
  }
}

// ---------- Attaching to messages (called by message.service) ----------

/**
 * Atomically claims a pending file for a message. It must belong to this sender and this room,
 * match the message type, be unsent and unexpired. Because it is ONE database operation,
 * the same file can never end up in two messages, even if two sends race.
 * The file's expiry is set to the message's expiry, so they disappear together.
 */
export async function claimMediaForMessage(params: {
  mediaId: string;
  uploaderId: string;
  roomId: string;
  kind: MediaKind;
  messageId: Types.ObjectId;
  messageExpiresAt: Date;
}): Promise<IMedia> {
  const claimed = await Media.findOneAndUpdate(
    {
      _id: params.mediaId,
      uploaderId: params.uploaderId,
      roomId: params.roomId,
      kind: params.kind,
      status: 'pending',
      messageId: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { status: 'attached', messageId: params.messageId, expiresAt: params.messageExpiresAt } },
    { new: true },
  ).lean<IMedia>();

  if (!claimed) {
    // One message for every cause, so it reveals nothing about files that are not yours
    throw ApiError.badRequest(
      'This file cannot be sent. It may have expired, been sent already, or not match the message type.',
      { code: 'MEDIA_NOT_AVAILABLE' },
    );
  }
  return claimed;
}

/** Undoes a claim when the message could not be saved, so the user can try again. */
export async function releaseMedia(mediaId: string, messageId: Types.ObjectId): Promise<void> {
  await Media.updateOne(
    { _id: mediaId, messageId, status: 'attached' },
    { $set: { status: 'pending', messageId: null } },
  );
}

// ---------- Authorised access ----------

const mediaNotFound = (): ApiError => ApiError.notFound('File not found', { code: 'MEDIA_NOT_FOUND' });

/**
 * THE gatekeeper for reading a file. Throws unless:
 *  - the requesting account is active
 *  - the file exists and the user is in its room, with no block either way
 *  - an unsent upload is only visible to the person who uploaded it
 *  - the file has not expired
 * A missing file and a file you may not see look identical (404 MEDIA_NOT_FOUND).
 */
async function loadAuthorizedMedia(userId: string, mediaId: string): Promise<IMedia> {
  const active = await User.exists({ _id: userId, status: 'active', deletedAt: null });
  if (!active) throw ApiError.forbidden('Your account is not active', { code: 'ACCOUNT_NOT_ACTIVE' });

  const media = await Media.findById(mediaId).lean<IMedia>();
  if (!media) throw mediaNotFound();

  try {
    await assertRoomAccess(String(media.roomId), userId);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) throw mediaNotFound();
    throw err; // e.g. blocked: the user is already in this room, so they know it exists
  }

  if (media.status === 'pending' && String(media.uploaderId) !== userId) throw mediaNotFound();

  if (media.expiresAt <= new Date()) {
    throw ApiError.gone('This file has expired', { code: 'MEDIA_EXPIRED' });
  }
  return media;
}

/** Opens a file for streaming to a user who passed every check. */
export async function openMediaFile(userId: string, mediaId: string): Promise<MediaFile> {
  const media = await loadAuthorizedMedia(userId, mediaId);
  const file = await openPrivateFile(media.storagePublicId, media.storageResourceType);

  return {
    stream: file.stream,
    mimeType: media.mimeType, // detected from the file's content at upload, not from the client
    sizeBytes: media.sizeBytes,
    originalName: media.originalName,
    kind: media.kind,
  };
}

// ---------- Signed links ----------
// A signed link lets an <img> or <video> tag load a file without sending headers. It is short-lived,
// tied to one file and one user, and every use is checked against the permission rules again.

const signingKey = (): Buffer =>
  crypto.createHmac('sha256', env.COOKIE_SECRET).update('media-url-v1').digest();

function computeSignature(mediaId: string, userId: string, exp: number): string {
  return crypto.createHmac('sha256', signingKey()).update(`${mediaId}.${userId}.${exp}`).digest('hex');
}

/** Returns a path (the frontend adds its API address in front). It never outlives the file itself. */
export async function createSignedMediaUrl(
  userId: string,
  mediaId: string,
): Promise<{ url: string; expiresAt: string }> {
  const media = await loadAuthorizedMedia(userId, mediaId);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = Math.min(nowSeconds + env.SIGNED_URL_EXPIRY_SECONDS, Math.floor(media.expiresAt.getTime() / 1000));
  const signature = computeSignature(mediaId, userId, exp);

  return {
    url: `/api/v1/media/${mediaId}/file?uid=${userId}&exp=${exp}&sig=${signature}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Checks a signed link. Returns the user it was issued to; the caller must still call openMediaFile with it. */
export function verifySignedMediaRequest(params: {
  mediaId: string;
  uid: string;
  exp: number;
  sig: string;
}): string {
  const invalid = (): ApiError =>
    ApiError.forbidden('This link is invalid or has expired', { code: 'INVALID_SIGNED_URL' });

  if (params.exp <= Math.floor(Date.now() / 1000)) throw invalid();

  const expected = computeSignature(params.mediaId, params.uid, params.exp);
  if (!safeEqual(params.sig.toLowerCase(), expected)) throw invalid();

  return params.uid;
}

// ---------- Cleanup (called by the media cleanup job) ----------

/**
 * Deletes expired files: storage FIRST, database record SECOND.
 * If storage fails, the record stays so the next run retries (the file is never orphaned).
 */
export async function deleteExpiredMedia(batchSize = 100): Promise<{ deleted: number; failed: number }> {
  const expired = await Media.find({ expiresAt: { $lte: new Date() } })
    .sort({ expiresAt: 1 })
    .limit(batchSize)
    .select('storagePublicId storageResourceType')
    .lean<IMedia[]>();

  let deleted = 0;
  let failed = 0;

  for (const media of expired) {
    try {
      await deleteFile(media.storagePublicId, media.storageResourceType, 'private');
      await Media.deleteOne({ _id: media._id });
      deleted++;
    } catch (err) {
      failed++;
      logger.error({ err, mediaId: String(media._id) }, 'Could not delete an expired file; will retry');
    }
  }
  return { deleted, failed };
}