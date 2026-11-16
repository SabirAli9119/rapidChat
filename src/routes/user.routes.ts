import { Router } from 'express';
import * as userController from '../controllers/user.controller';
import { authenticate, requireVerifiedEmail } from '../middlewares/auth.middleware';
import { loginRateLimit, uploadRateLimit } from '../middlewares/rateLimit.middleware';
import { receiveAvatarUpload } from '../middlewares/upload.middleware';
import { validate } from '../middlewares/validation.middleware';
import {
  deleteAccountSchema,
  updateProfileSchema,
  userIdParamsSchema,
} from '../validators/user.validator';

const router = Router();

// ----- your own account (every "/me" route comes BEFORE "/:userId") -----
router.get('/me', authenticate, userController.getMe);
router.patch('/me', authenticate, validate(updateProfileSchema), userController.updateMe);
router.delete('/me', authenticate, loginRateLimit, validate(deleteAccountSchema), userController.deleteMe);

// Rate limit first, then the upload is received and checked, then the controller runs
router.post(
  '/me/avatar',
  authenticate,
  uploadRateLimit,
  ...receiveAvatarUpload,
  userController.uploadAvatar,
);
router.delete('/me/avatar', authenticate, userController.removeAvatar);

// ----- other people: MUST be last, or ":userId" would swallow the word "me" -----
router.get(
  '/:userId',
  authenticate,
  requireVerifiedEmail,
  validate(userIdParamsSchema),
  userController.getProfile,
);

export default router;