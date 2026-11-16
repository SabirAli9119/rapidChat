import type { Request, Response } from 'express';
import { requireUser } from '../middlewares/auth.middleware';
import * as nearbyService from '../services/nearby.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { SearchNearbyInput, UpdateLocationInput } from '../validators/nearby.validator';

export const updateLocation = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const status = await nearbyService.updateLocation(me.id, req.body as UpdateLocationInput);
  // The response never echoes coordinates back
  ApiResponse.ok(res, status, 'Location updated');
});

export const getLocationStatus = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  ApiResponse.ok(res, await nearbyService.getLocationStatus(me.id), 'Location status');
});

export const removeLocation = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  await nearbyService.removeLocation(me.id);
  ApiResponse.ok(res, null, 'You are no longer sharing your location');
});

export const search = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const { items, ...meta } = await nearbyService.searchNearby(me.id, req.query as unknown as SearchNearbyInput);
  ApiResponse.ok(res, items, 'People nearby', meta);
});