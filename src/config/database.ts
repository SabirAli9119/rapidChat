import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

// Reject query filters that use fields not defined in the schema
mongoose.set('strictQuery', true);

let listenersRegistered = false;

function registerConnectionListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
}

/** Connects to MongoDB. Throws if the connection cannot be established. */
export async function connectDatabase(): Promise<typeof mongoose> {
  registerConnectionListeners();

  try {
    return await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000, // fail fast if MongoDB isn't running
      maxPoolSize: 20,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to connect to MongoDB. Is MongoDB running and MONGODB_URI correct?');
    throw err;
  }
}

/** Closes the MongoDB connection (used during graceful shutdown and tests). */
export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info('MongoDB connection closed');
}