import { Router } from 'express';
import * as messageController from '../controllers/message.controller';
import { authenticate, requireVerifiedEmail } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validation.middleware';
import { listMessagesSchema } from '../validators/message.validator';

const router = Router({ mergeParams: true });

// History only. Sending a message happens over Socket.IO (see the sockets phase).
router.get('/', authenticate, requireVerifiedEmail, validate(listMessagesSchema), messageController.listMessages);

export default router;