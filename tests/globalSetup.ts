import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | undefined;

export async function setup(): Promise<void> {
  // The database's own TTL deleter is switched off, so only the code under test ever deletes anything
  mongod = await MongoMemoryServer.create({
    instance: { args: ['--setParameter', 'ttlMonitorEnabled=false'] },
  });
  process.env.TEST_MONGO_URI = mongod.getUri(); // e.g. mongodb://127.0.0.1:51234/
}

export async function teardown(): Promise<void> {
  await mongod?.stop();
}