import { Router } from 'express';
import * as nearbyController from '../controllers/nearby.controller';
import { authenticate, requireVerifiedEmail } from '../middlewares/auth.middleware';
import { nearbyRateLimit } from '../middlewares/rateLimit.middleware';
import { validate } from '../middlewares/validation.middleware';
import { searchNearbySchema, updateLocationSchema } from '../validators/nearby.validator';

const router = Router();

// Every nearby route needs a verified account and shares one limit.
// Repeated searches from many positions are the main way to try to pin down someone's location.
router.use(authenticate, requireVerifiedEmail, nearbyRateLimit);

router.post('/location', validate(updateLocationSchema), nearbyController.updateLocation);
router.get('/location', nearbyController.getLocationStatus);
router.delete('/location', nearbyController.removeLocation);
router.get('/', validate(searchNearbySchema), nearbyController.search);

export default router;