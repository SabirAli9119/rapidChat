import type { Request, Response } from 'express';
import type { z } from 'zod';
import { requireUser } from '../middlewares/auth.middleware';
import * as blockService from '../services/block.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { listBlocksSchema } from '../validators/block.validator';

type ListBlocksQuery = z.infer<typeof listBlocksSchema>['query'];

export const blockUser = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  await blockService.blockUser(me.id, req.params.userId);
  ApiResponse.ok(res, null, 'User blocked');
});

export const unblockUser = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  await blockService.unblockUser(me.id, req.params.userId);
  ApiResponse.ok(res, null, 'User unblocked');
});

export const listBlocked = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const { items, ...meta } = await blockService.listBlockedUsers(me.id, req.query as unknown as ListBlocksQuery);
  ApiResponse.ok(res, items, 'Blocked users', meta);
});