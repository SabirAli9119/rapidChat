import { Router } from 'express';
import * as blockController from '../controllers/block.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validation.middleware';
import { blockParamsSchema, listBlocksSchema } from '../validators/block.validator';

const router = Router();

router.use(authenticate);

router.get('/', validate(listBlocksSchema), blockController.listBlocked);
router.post('/:userId', validate(blockParamsSchema), blockController.blockUser);
router.delete('/:userId', validate(blockParamsSchema), blockController.unblockUser);

export default router;