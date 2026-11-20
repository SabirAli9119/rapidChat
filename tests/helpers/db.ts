import mongoose from 'mongoose';

/**
 * Connects to the shared temporary MongoDB, in a database of its own (so test files never see each other's data).
 * Call this AFTER the project's models are imported, so their indexes get built.
 */
export async function connectTestDb(): Promise<void> {
  const base = process.env.TEST_MONGO_URI;
  if (!base) throw new Error('TEST_MONGO_URI is missing: tests/globalSetup.ts did not run');

  const name = `test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await mongoose.connect(`${base}${name}`);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

/** Empties every collection (the indexes stay). */
export async function clearDb(): Promise<void> {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
}