import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { env } from './config/env';
import { connectRedis, disconnectRedis } from './config/redis';
import { initQueues, type InitQueuesOptions, type QueueRuntime } from './queues';
import { resetPresence } from './services/presence.service';
import { initSockets, type InitSocketsOptions, type SocketRuntime } from './sockets';
import { logger } from './utils/logger';

export interface StartOptions {
  /** 0 picks a free port (tests). Default: PORT from .env */
  port?: number;
  host?: string;
  /** Overrides RUN_WORKERS_IN_SERVER */
  runWorkers?: boolean;
  sockets?: InitSocketsOptions;
  queues?: InitQueuesOptions;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  /** Stops everything in the right order. Safe to call more than once. */
  stop: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A short, human explanation for the errors people actually hit when starting a server. */
export function describeListenError(err: unknown, port: number): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use. Stop the other program (or the other copy of this server), or change PORT in .env.`;
  }
  if (code === 'EACCES') {
    return `Not allowed to use port ${port}. Choose a port above 1024 in PORT.`;
  }
  return err instanceof Error ? err.message : String(err);
}

function listen(server: http.Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Starts everything: databases, HTTP, Socket.IO and (optionally) the background jobs.
 * If any step fails, whatever already started is shut down again and the error is thrown.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? env.PORT;
  const runWorkers = options.runWorkers ?? env.RUN_WORKERS_IN_SERVER;

  let server: http.Server | null = null;
  let sockets: SocketRuntime | null = null;
  let queues: QueueRuntime | null = null;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;

    // 1. Stop taking new connections. Closing Socket.IO also closes the HTTP server;
    //    requests already in progress are allowed to finish.
    if (sockets) {
      const closing = sockets.close();
      server?.closeIdleConnections();
      await closing;
      // The "disconnect" handlers (last-seen, offline announcements) run asynchronously: give them a moment
      await sleep(300);
    } else if (server?.listening) {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
        server?.closeIdleConnections();
      });
    }

    // 2. Let any running background job finish, then close the data stores
    if (queues) await queues.close().catch((err) => logger.error({ err }, 'Could not close the job queues cleanly'));
    await disconnectRedis().catch((err) => logger.error({ err }, 'Could not close Redis cleanly'));
    await disconnectDatabase().catch((err) => logger.error({ err }, 'Could not close MongoDB cleanly'));
  };

  try {
    await connectDatabase();
    await connectRedis();
    // After a crash nobody is really connected any more, so every "online" flag is stale
    await resetPresence();

    server = http.createServer(createApp());
    // Slightly longer than the 60 s idle timeout of common load balancers (AWS, Render...)
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    sockets = initSockets(server, options.sockets);
    await listen(server, port, options.host);
    if (runWorkers) queues = await initQueues(options.queues);
  } catch (err) {
    await stop().catch(() => undefined);
    throw err;
  }

  const actualPort = (server.address() as AddressInfo).port;
  logger.info(
    {
      port: actualPort,
      environment: env.NODE_ENV,
      backgroundJobs: runWorkers ? 'running in this process' : 'expected in a separate worker process',
    },
    `Nearby Chat API ready at http://localhost:${actualPort}/api/v1 (health check: /api/v1/health)`,
  );

  return { server, port: actualPort, stop };
}

// ---------- Running from the command line (npm run dev / npm start) ----------

async function run(): Promise<void> {
  let running: RunningServer;
  try {
    running = await startServer();
  } catch (err) {
    logger.fatal({ err }, `Could not start the server. ${describeListenError(err, env.PORT)}`);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down...');

    // Safety net: if something refuses to finish, leave anyway
    const force = setTimeout(() => {
      logger.error('Shutdown took too long, forcing exit');
      process.exit(1);
    }, 15_000);
    force.unref();

    let code = exitCode;
    try {
      await running.stop();
      logger.info('Shutdown complete');
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      code = 1;
    }
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0)); // Ctrl+C
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0)); // hosting platforms stop the app this way
  // After an unexpected error the program state cannot be trusted: log it, shut down cleanly, exit with an error
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

// True only when this file is the program being run, not when a test imports it
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void run();
}