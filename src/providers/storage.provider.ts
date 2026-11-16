import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { UploadApiErrorResponse, UploadApiResponse } from 'cloudinary';
import { cloudinary, isCloudinaryConfigured } from '../config/cloudinary';
import type { StorageResourceType } from '../models/Media.model';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

export type StorageAccess = 'public' | 'private';

export interface UploadParams {
  buffer: Buffer;
  /** Logical folder, e.g. "avatars" or "chat-media" */
  folder: string;
  resourceType: StorageResourceType;
  access: StorageAccess;
}

export interface UploadedFile {
  publicId: string;
  bytes: number;
}

export interface PrivateFile {
  stream: Readable;
  contentLength: number | null;
  contentType: string | null;
}

function requireConfigured(): void {
  if (!isCloudinaryConfigured) {
    throw new ApiError(503, 'File storage is not configured on the server', {
      code: 'STORAGE_NOT_CONFIGURED',
    });
  }
}

const deliveryType = (access: StorageAccess): 'upload' | 'authenticated' =>
  access === 'private' ? 'authenticated' : 'upload';

/**
 * Uploads a file. The storage id is generated here (random UUID), so it is
 * unguessable and never derived from the user's file name.
 */
export async function uploadBuffer(params: UploadParams): Promise<UploadedFile> {
  requireConfigured();

  // The folder is part of the id itself, which works in every Cloudinary folder mode
  const publicId = `${params.folder}/${crypto.randomUUID()}`;

  return new Promise<UploadedFile>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: params.resourceType,
        type: deliveryType(params.access),
        overwrite: false,
        use_filename: false,
        unique_filename: false,
      },
      (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        if (error || !result) {
          logger.error({ err: error }, 'Cloudinary upload failed');
          return reject(new ApiError(502, 'File storage upload failed', { code: 'STORAGE_UPLOAD_FAILED' }));
        }
        resolve({ publicId: result.public_id, bytes: result.bytes });
      },
    );
    stream.end(params.buffer);
  });
}

/**
 * Deletes a stored file. THROWS if storage fails, so callers decide whether to
 * retry later (cleanup jobs) or just log (best-effort cleanup).
 * Deleting a file that no longer exists is not an error.
 */
export async function deleteFile(
  publicId: string,
  resourceType: StorageResourceType,
  access: StorageAccess,
): Promise<void> {
  if (!isCloudinaryConfigured) return; // nothing can have been stored
  await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    type: deliveryType(access),
    invalidate: true,
  });
}

/** URL for a profile picture (256x256, cropped). Null when there is no avatar. */
export function getAvatarUrl(publicId: string | null): string | null {
  if (!publicId || !isCloudinaryConfigured) return null;
  return cloudinary.url(publicId, {
    resource_type: 'image',
    type: 'upload',
    secure: true,
    width: 256,
    height: 256,
    crop: 'fill',
    gravity: 'auto',
    fetch_format: 'auto',
    quality: 'auto',
  });
}

/**
 * Opens a PRIVATE file for streaming to an authorized user.
 * The signed storage URL is built and used on the server only. It is never sent to a client.
 */
export async function openPrivateFile(
  publicId: string,
  resourceType: StorageResourceType,
): Promise<PrivateFile> {
  requireConfigured();

  const url = cloudinary.url(publicId, {
    resource_type: resourceType,
    type: 'authenticated',
    sign_url: true,
    secure: true,
  });

  const response = await fetch(url);

  if (response.status === 404) {
    throw ApiError.gone('This file is no longer available', { code: 'FILE_GONE' });
  }
  if (!response.ok || !response.body) {
    logger.error({ status: response.status }, 'Private file fetch failed');
    throw new ApiError(502, 'Could not load the file from storage', { code: 'STORAGE_FETCH_FAILED' });
  }

  const length = response.headers.get('content-length');
  return {
    stream: Readable.fromWeb(response.body as unknown as WebReadableStream),
    contentLength: length ? Number(length) : null,
    contentType: response.headers.get('content-type'),
  };
}