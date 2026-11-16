import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { extractAccessToken, requireUser, resolveUserFromAccessToken } from '../middlewares/auth.middleware';
import * as mediaService from '../services/media.service';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import { buildContentDisposition } from '../utils/http';
import { logger } from '../utils/logger';
import type { mediaFileSchema, uploadMediaSchema } from '../validators/media.validator';

type UploadBody = z.infer<typeof uploadMediaSchema>['body'];
type FileQuery = z.infer<typeof mediaFileSchema>['query'];

/** The route runs the upload middlewares first: they check the file and fill req.upload. */
export const upload = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  if (!req.upload) throw ApiError.badRequest('No file uploaded', { code: 'NO_FILE' });

  const { roomId } = req.body as UploadBody;
  const media = await mediaService.uploadMedia(me.id, roomId, req.upload);
  ApiResponse.created(res, { media }, 'File uploaded. Send it in a message within 30 minutes.');
});

/** A short-lived link for <img src> and <video src>. Every use of the link is checked again. */
export const getSignedUrl = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const link = await mediaService.createSignedMediaUrl(me.id, req.params.mediaId);
  ApiResponse.ok(res, link, 'Signed link created');
});

/** Who is asking: the person named in a valid signed link, or the logged-in user. */
async function resolveViewerId(req: Request): Promise<string> {
  const query = req.query as unknown as FileQuery;

  if (query.uid !== undefined && query.exp !== undefined && query.sig !== undefined) {
    return mediaService.verifySignedMediaRequest({
      mediaId: req.params.mediaId,
      uid: query.uid,
      exp: query.exp,
      sig: query.sig,
    });
  }

  const token = extractAccessToken(req);
  if (!token) throw ApiError.unauthorized('Authentication required', { code: 'NO_TOKEN' });
  return (await resolveUserFromAccessToken(token)).id;
}

const FILE_HEADERS = ['Content-Type', 'Content-Disposition'];

/** Streams the file to a user who passes every permission check (those live in the service). */
export const download = asyncHandler(async (req: Request, res: Response) => {
  const viewerId = await resolveViewerId(req);
  const file = await mediaService.openMediaFile(viewerId, req.params.mediaId);

  // The type was detected from the file's content when it was uploaded. It is never client-supplied.
  res.setHeader(
    'Content-Type',
    file.mimeType.startsWith('text/') ? `${file.mimeType}; charset=utf-8` : file.mimeType,
  );
  res.setHeader('Content-Disposition', buildContentDisposition(file.kind, file.originalName));
  res.setHeader('X-Content-Type-Options', 'nosniff'); // the browser must trust our type, never guess
  res.setHeader('Cache-Control', 'private, no-store'); // expiring files must not linger in caches
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); // even if opened directly, nothing can run
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site'); // lets your frontend (same site) embed it

  try {
    await pipeline(file.stream, res);
  } catch (err) {
    if (res.headersSent) {
      // The download had already started (e.g. the user closed the tab): all we can do is stop
      res.destroy();
      logger.debug({ err }, 'File download interrupted');
      return;
    }
    for (const name of FILE_HEADERS) res.removeHeader(name);
    throw err; // nothing was sent yet, so the error handler can answer normally
  }
});