import { Router } from 'express';
import * as chatController from '../controllers/chat.controller';
import { authenticate, requireVerifiedEmail } from '../middlewares/auth.middleware';
import { nearbyRateLimit } from '../middlewares/rateLimit.middleware';
import { validate } from '../middlewares/validation.middleware';
import { createRoomSchema, listRoomsSchema, roomIdParamsSchema } from '../validators/chat.validator';

const router = Router();

router.use(authenticate, requireVerifiedEmail);

// Starting a chat can reveal whether a user id exists, so it shares the location limit
router.post('/', nearbyRateLimit, validate(createRoomSchema), chatController.createRoom);
router.get('/', validate(listRoomsSchema), chatController.listRooms);
router.get('/:roomId', validate(roomIdParamsSchema), chatController.getRoom);

export default router;