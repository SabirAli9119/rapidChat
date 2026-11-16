import { v2 as cloudinary } from 'cloudinary';
import { env, isTest } from './env';
import { logger } from '../utils/logger';

/** True when all three Cloudinary credentials are present. */
export const isCloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true, // always use https URLs
  });
} else if (!isTest) {
  logger.warn('Cloudinary is not configured. Media uploads will be unavailable until you set CLOUDINARY_* in .env');
}

export { cloudinary };