import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

const baseOptions: RedisOptions = {
  enableReadyCheck: true,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5000), // back off up to 5 seconds
};

function attachListeners(client: Redis, name: string): Redis {
  client.on('connect', () => logger.info(`Redis (${name}) connecting`));
  client.on('ready', () => logger.info(`Redis (${name}) ready`));
  client.on('error', (err) => logger.error({ err }, `Redis (${name}) error`));
  client.on('close', () => logger.warn(`Redis (${name}) connection closed`));
  return client;
}

/**
 * General-purpose client: rate limiting, presence tracking, caching.
 * Commands fail quickly (3 retries) if Redis is down, instead of hanging.
 * lazyConnect: it only connects when connectRedis() is called.
 */
export const redis = attachListeners(
  new Redis(env.REDIS_URL, { ...baseOptions, maxRetriesPerRequest: 3, lazyConnect: true }),
  'app',
);

/**
 * Creates a NEW connection for a BullMQ Queue or Worker.
 * BullMQ requires maxRetriesPerRequest to be null.
 */
export function createQueueConnection(name = 'queue'): Redis {
  return attachListeners(
    new Redis(env.REDIS_URL, { ...baseOptions, maxRetriesPerRequest: null }),
    name,
  );
}

/** Connects the general client and confirms Redis responds. */
export async function connectRedis(): Promise<void> {
  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    await redis.ping();
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Redis. Is Redis running and REDIS_URL correct?');
    throw err;
  }
}

/** Closes the general Redis client (used during graceful shutdown and tests). */
// export async function disconnectRedis(): Promise<void> {
//   if (redis.status !== 'end') {
//     await redis.quit();
//   }
//   logger.info('Redis connection closed');
// }


export async function disconnectRedis(): Promise<void> {
  if (redis.status === 'ready') {
    await redis.quit(); // finishes pending commands, then closes
  } else if (redis.status !== 'end') {
    redis.disconnect(); // never connected, or the connection was lost: close immediately
  }
  logger.info('Redis connection closed');
}