import { Router } from 'express';
import * as notificationController from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validation.middleware';
import {
  listNotificationsSchema,
  notificationIdParamsSchema,
} from '../validators/notification.validator';

const router = Router();

router.use(authenticate);

router.get('/', validate(listNotificationsSchema), notificationController.list);
router.get('/unread-count', notificationController.unreadCount);
router.post('/read-all', notificationController.markAllRead);
router.patch(
  '/:notificationId/read',
  validate(notificationIdParamsSchema),
  notificationController.markRead,
);

export default router;