import type { Request, Response } from 'express';
import type { z } from 'zod';
import { requireUser } from '../middlewares/auth.middleware';
import * as messageService from '../services/message.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { listMessagesSchema } from '../validators/message.validator';

type ListMessagesQuery = z.infer<typeof listMessagesSchema>['query'];

/** Newest first. Pass meta.nextCursor back as ?cursor= to load older messages. */
export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const query = req.query as unknown as ListMessagesQuery;

  const page = await messageService.listMessages(me.id, req.params.roomId, {
    cursor: query.cursor,
    limit: query.limit,
  });
  ApiResponse.ok(res, page.items, 'Messages', { nextCursor: page.nextCursor });
});