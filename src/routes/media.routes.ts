import { Router } from 'express';
import * as mediaController from '../controllers/media.controller';
import { authenticate, requireVerifiedEmail } from '../middlewares/auth.middleware';
import { uploadRateLimit } from '../middlewares/rateLimit.middleware';
import { receiveMediaUpload } from '../middlewares/upload.middleware';
import { validate } from '../middlewares/validation.middleware';
import {
  mediaFileSchema,
  mediaIdParamsSchema,
  uploadMediaSchema,
} from '../validators/media.validator';

const router = Router();

// The upload is received and checked BEFORE validate: Multer is what fills req.body.roomId
router.post(
  '/',
  authenticate,
  requireVerifiedEmail,
  uploadRateLimit,
  ...receiveMediaUpload,
  validate(uploadMediaSchema),
  mediaController.upload,
);

router.get(
  '/:mediaId/url',
  authenticate,
  requireVerifiedEmail,
  validate(mediaIdParamsSchema),
  mediaController.getSignedUrl,
);

// Deliberately NOT behind authenticate: the controller accepts either a logged-in request
// or a signed link (so <img> and <video> tags work), and the service re-checks every permission.
router.get('/:mediaId/file', validate(mediaFileSchema), mediaController.download);

export default router;