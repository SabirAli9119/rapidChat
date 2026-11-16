import type { Request, Response } from 'express';
import type { z } from 'zod';
import { requireUser } from '../middlewares/auth.middleware';
import * as notificationService from '../services/notification.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { listNotificationsSchema } from '../validators/notification.validator';

type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>['query'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  // "meta" carries page, limit, total, totalPages and unreadCount
  const { items, ...meta } = await notificationService.listNotifications(
    me.id,
    req.query as unknown as ListNotificationsQuery,
  );
  ApiResponse.ok(res, items, 'Notifications', meta);
});

export const unreadCount = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  ApiResponse.ok(res, { count: await notificationService.getUnreadCount(me.id) }, 'Unread notifications');
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const notification = await notificationService.markAsRead(me.id, req.params.notificationId);
  ApiResponse.ok(res, { notification }, 'Notification marked as read');
});

export const markAllRead = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const updated = await notificationService.markAllAsRead(me.id);
  ApiResponse.ok(res, { updated }, 'All notifications marked as read');
});