import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis } from './config/redis';
import { initQueues } from './queues';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  await connectDatabase();
  await connectRedis();
  const queues = await initQueues();

  logger.info(
    'Background worker running. (Note: only the API server process can tell connected apps that a message expired.)',
  );

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Worker shutting down...');

    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();

    let code = exitCode;
    try {
      await queues.close(); // waits for a running job to finish
      await disconnectRedis();
      await disconnectDatabase();
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      code = 1;
    }
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection in the worker');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in the worker');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'The worker could not start');
  process.exit(1);
});