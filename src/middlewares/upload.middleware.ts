import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { fromBuffer } from 'file-type';
import multer from 'multer';
import { env } from '../config/env';
import { MAX_MEDIA_SIZE_BYTES, type StorageResourceType } from '../models/Media.model';
import type { MediaKind } from '../types';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/** A file that passed every check. Controllers/services read it from req.upload. */
export interface VerifiedUpload {
  buffer: Buffer;
  /** Display name only. NEVER use it to build storage paths. */
  originalName: string;
  /** Detected from the file's content, not claimed by the client */
  mimeType: string;
  sizeBytes: number;
  kind: MediaKind;
  storageResourceType: StorageResourceType;
}

declare global {
  namespace Express {
    interface Request {
      upload?: VerifiedUpload;
    }
  }
}

/**
 * The ONLY file types accepted (by detected content type).
 * Not included on purpose: SVG, HTML, scripts, executables, archives (can carry active content).
 */
const ALLOWED_TYPES: Record<string, { kind: MediaKind; storageResourceType: StorageResourceType }> = {
  // images
  'image/jpeg': { kind: 'image', storageResourceType: 'image' },
  'image/png': { kind: 'image', storageResourceType: 'image' },
  'image/webp': { kind: 'image', storageResourceType: 'image' },
  'image/gif': { kind: 'image', storageResourceType: 'image' },
  // video
  'video/mp4': { kind: 'video', storageResourceType: 'video' },
  'video/webm': { kind: 'video', storageResourceType: 'video' },
  'video/quicktime': { kind: 'video', storageResourceType: 'video' },
  // audio (Cloudinary stores audio under "video")
  'audio/mpeg': { kind: 'audio', storageResourceType: 'video' },
  'audio/ogg': { kind: 'audio', storageResourceType: 'video' },
  'audio/opus': { kind: 'audio', storageResourceType: 'video' },
  'audio/aac': { kind: 'audio', storageResourceType: 'video' },
  'audio/mp4': { kind: 'audio', storageResourceType: 'video' },
  'audio/x-m4a': { kind: 'audio', storageResourceType: 'video' },
  'audio/vnd.wave': { kind: 'audio', storageResourceType: 'video' },
  // documents (Cloudinary stores them as "raw")
  'application/pdf': { kind: 'document', storageResourceType: 'raw' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', storageResourceType: 'raw' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', storageResourceType: 'raw' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', storageResourceType: 'raw' },
  'text/plain': { kind: 'document', storageResourceType: 'raw' },
};

/** Plain text has no "magic bytes", so we check it differently: no NUL bytes and valid UTF-8. */
function isPlainText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

async function detectMimeType(buffer: Buffer, declaredMime: string): Promise<string | null> {
  const detected = await fromBuffer(buffer); // reads the file's real signature
  if (detected) return detected.mime;
  if (declaredMime === 'text/plain' && isPlainText(buffer)) return 'text/plain';
  return null;
}

/** Strips folders and control characters. Kept only for display. */
function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  return (cleaned || 'file').slice(0, 255);
}

interface UploadOptions {
  allowedKinds: readonly MediaKind[];
  maxBytes: number;
}

/** Returns two middlewares to spread into a route: [receive the file, verify the file]. */
function createUploadMiddleware({ allowedKinds, maxBytes }: UploadOptions): RequestHandler[] {
  const receive = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1024, parts: 12 },
  }).single('file'); // the form field must be named "file"

  const verify = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const file = req.file;
    if (!file) {
      throw ApiError.badRequest(
        'No file uploaded. Send it as multipart/form-data in a field named "file"',
        { code: 'NO_FILE' },
      );
    }
    if (file.size === 0) {
      throw ApiError.badRequest('The uploaded file is empty', { code: 'EMPTY_FILE' });
    }

    const mimeType = await detectMimeType(file.buffer, file.mimetype);
    const rule = mimeType ? ALLOWED_TYPES[mimeType] : undefined;

    if (!mimeType || !rule || !allowedKinds.includes(rule.kind)) {
      throw new ApiError(415, 'This file type is not allowed', { code: 'FILE_TYPE_NOT_ALLOWED' });
    }

    req.upload = {
      buffer: file.buffer,
      originalName: sanitizeFileName(file.originalname),
      mimeType,
      sizeBytes: file.size,
      kind: rule.kind,
      storageResourceType: rule.storageResourceType,
    };
    next();
  });

  return [receive, verify];
}

// Never above 10 MB, even if .env is edited
const mediaMaxBytes = Math.min(env.MAX_FILE_SIZE_MB * 1024 * 1024, MAX_MEDIA_SIZE_BYTES);

/** Chat attachments: images, video, audio, documents (max 10 MB). */
export const receiveMediaUpload = createUploadMiddleware({
  allowedKinds: ['image', 'video', 'audio', 'document'],
  maxBytes: mediaMaxBytes,
});

/** Profile pictures: images only (max 5 MB). */
export const receiveAvatarUpload = createUploadMiddleware({
  allowedKinds: ['image'],
  maxBytes: Math.min(5 * 1024 * 1024, mediaMaxBytes),
});