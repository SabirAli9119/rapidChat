import { Router } from 'express';
import * as privacyController from '../controllers/privacy.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validation.middleware';
import { updatePrivacySchema } from '../validators/user.validator';

const router = Router();

router.use(authenticate);

router.get('/', privacyController.getSettings);
router.patch('/', validate(updatePrivacySchema), privacyController.updateSettings);

export default router;