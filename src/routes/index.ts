import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { redis } from '../config/redis';
import { apiRateLimit } from '../middlewares/rateLimit.middleware';
import adminRoutes from './admin.routes';
import authRoutes from './auth.routes';
import blockRoutes from './block.routes';
import chatRoutes from './chat.routes';
import mediaRoutes from './media.routes';
import messageRoutes from './message.routes';
import nearbyRoutes from './nearby.routes';
import notificationRoutes from './notification.routes';
import privacyRoutes from './privacy.routes';
import reportRoutes from './report.routes';
import userRoutes from './user.routes';

const router = Router();

/**
 * GET /api/v1/health: used by hosting platforms and monitors.
 * Registered BEFORE the rate limiter so a monitor polling often is never blocked.
 * It only reads connection state (no queries), so it is cheap and cannot hang.
 */
router.get('/health', (_req: Request, res: Response) => {
  const mongodbUp = mongoose.connection.readyState === 1;
  const redisUp = redis.status === 'ready';
  const healthy = mongodbUp && redisUp;

  res.setHeader('Cache-Control', 'no-store');
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? 'Healthy' : 'Service unavailable',
    data: {
      status: healthy ? 'ok' : 'degraded',
      checks: { mongodb: mongodbUp ? 'up' : 'down', redis: redisUp ? 'up' : 'down' },
      timestamp: new Date().toISOString(),
    },
  });
});

// A general limit for the whole API (every IP). Routes add their own stricter limits on top.
router.use(apiRateLimit);

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/nearby', nearbyRoutes);
// Message history: same router, two URLs (see message.routes.ts). Mounted before "/rooms".
router.use('/rooms/:roomId/messages', messageRoutes);
router.use('/messages/:roomId', messageRoutes);
router.use('/rooms', chatRoutes);
router.use('/media', mediaRoutes);
router.use('/privacy', privacyRoutes);
router.use('/notifications', notificationRoutes);
router.use('/blocks', blockRoutes);
router.use('/reports', reportRoutes);
router.use('/admin', adminRoutes);

export default router;