import type { Request, Response } from 'express';
import { requireUser } from '../middlewares/auth.middleware';
import * as privacyService from '../services/privacy.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { UpdatePrivacyInput } from '../validators/user.validator';

export const getSettings = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  ApiResponse.ok(res, { settings: await privacyService.getPrivacySettings(me.id) }, 'Privacy settings');
});

export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const settings = await privacyService.updatePrivacySettings(me.id, req.body as UpdatePrivacyInput);
  ApiResponse.ok(res, { settings }, 'Privacy settings updated');
});