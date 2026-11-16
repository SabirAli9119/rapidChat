import type { Request, Response } from 'express';
import { requireUser } from '../middlewares/auth.middleware';
import * as userService from '../services/user.service';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import { clearAuthCookies } from '../utils/cookies';
import type { UpdateProfileInput } from '../validators/user.validator';

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  ApiResponse.ok(res, { user: await userService.getMe(me.id) }, 'Profile loaded');
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const user = await userService.updateProfile(me.id, req.body as UpdateProfileInput);
  ApiResponse.ok(res, { user }, 'Profile updated');
});

/** The route runs receiveAvatarUpload first, which checks the file and fills req.upload. */
export const uploadAvatar = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  if (!req.upload) throw ApiError.badRequest('No file uploaded', { code: 'NO_FILE' });

  const user = await userService.updateAvatar(me.id, req.upload);
  ApiResponse.ok(res, { user }, 'Profile picture updated');
});

export const removeAvatar = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  ApiResponse.ok(res, { user: await userService.removeAvatar(me.id) }, 'Profile picture removed');
});

/** Another user's public profile (privacy and blocking rules are applied inside the service). */
export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const user = await userService.getPublicProfile(me.id, req.params.userId);
  ApiResponse.ok(res, { user }, 'Profile loaded');
});

export const deleteMe = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const { password } = req.body as { password: string }; // "confirmation" was already checked by the validator
  await userService.deleteAccount(me.id, password);

  clearAuthCookies(res);
  ApiResponse.ok(res, null, 'Your account has been deleted');
});