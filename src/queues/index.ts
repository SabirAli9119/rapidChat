import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createQueueConnection } from '../config/redis';
import { runLocationCleanup } from '../jobs/locationCleanup.job';
import { runMediaCleanup } from '../jobs/mediaCleanup.job';
import { runMessageCleanup } from '../jobs/messageCleanup.job';
import { runNotificationCleanup } from '../jobs/notification.job';
import { runSessionCleanup } from '../jobs/sessionCleanup.job';
import { logger } from '../utils/logger';

export const JOB_NAMES = [
  'message-cleanup',
  'media-cleanup',
  'location-cleanup',
  'session-cleanup',
  'notification-cleanup',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** What a job reports back: counts only. */
export type JobResult = Record<string, number>;
export type JobRunner = () => Promise<JobResult>;

export const JOB_INTERVALS_MS: Record<JobName, number> = {
  'message-cleanup': 30_000,
  'media-cleanup': 60_000,
  'location-cleanup': 5 * 60_000,
  'session-cleanup': 60 * 60_000,
  'notification-cleanup': 60 * 60_000,
};

const DEFAULT_RUNNERS: Record<JobName, JobRunner> = {
  'message-cleanup': runMessageCleanup,
  'media-cleanup': runMediaCleanup,
  'location-cleanup': runLocationCleanup,
  'session-cleanup': runSessionCleanup,
  'notification-cleanup': runNotificationCleanup,
};

/**
 * No retries: these jobs repeat anyway, so a failed run is simply replaced by the next scheduled one.
 * The last 50 failures are kept in Redis for inspection.
 */
const JOB_OPTIONS = { attempts: 1, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } };

export interface InitQueuesOptions {
  /** Redis key prefix. Tests use their own so they never touch real queues. Default: "bull". */
  prefix?: string;
  /** Overrides how often each job runs (tests). */
  intervalsMs?: Partial<Record<JobName, number>>;
  /** Replaces what a job does (tests). */
  runners?: Partial<Record<JobName, JobRunner>>;
}

export interface QueueRuntime {
  queues: Record<JobName, Queue>;
  /** Waits for running jobs to finish, then closes every queue, worker and Redis connection. */
  close: () => Promise<void>;
}

const asConnection = (connection: Redis): ConnectionOptions => connection as unknown as ConnectionOptions;

function logJobResult(job: JobName, result: JobResult | undefined): void {
  const failed = result?.failed ?? 0;
  if (failed > 0) {
    logger.warn({ job, result }, 'Background job finished with failures');
  } else if (Object.values(result ?? {}).some((value) => value > 0)) {
    logger.info({ job, result }, 'Background job cleaned up');
  } else {
    logger.debug({ job }, 'Background job: nothing to do');
  }
}

/**
 * Creates the queues, registers the repeating schedules, and starts one worker per queue.
 * Safe to call from several processes (the API server and a separate worker): registering a schedule
 * twice changes nothing, and each scheduled run is picked up by exactly one worker.
 */
export async function initQueues(options: InitQueuesOptions = {}): Promise<QueueRuntime> {
  const prefix = options.prefix ?? 'bull';

  // Queues share one connection; workers share another. BullMQ opens its own extra connection
  // for each worker's blocking wait. Both are created with maxRetriesPerRequest: null (BullMQ requires it).
  const queueConnection = createQueueConnection('queues');
  const workerConnection = createQueueConnection('workers');

  const queues = {} as Record<JobName, Queue>;
  const workers: Worker[] = [];
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
    await Promise.allSettled([queueConnection.quit(), workerConnection.quit()]);
  };

  try {
    for (const name of JOB_NAMES) {
      const runner = options.runners?.[name] ?? DEFAULT_RUNNERS[name];
      const everyMs = options.intervalsMs?.[name] ?? JOB_INTERVALS_MS[name];

      const queue = new Queue(name, {
        connection: asConnection(queueConnection),
        prefix,
        defaultJobOptions: JOB_OPTIONS,
      });
      queue.on('error', (err) => logger.error({ err, queue: name }, 'Queue error'));
      queues[name] = queue;

      // Idempotent: the schedule id is the job name
      await queue.upsertJobScheduler(name, { every: everyMs }, { name, data: {}, opts: JOB_OPTIONS });

      const worker = new Worker<unknown, JobResult>(name, async () => runner(), {
        connection: asConnection(workerConnection),
        prefix,
        concurrency: 1, // a cleanup never overlaps with itself
      });
      worker.on('completed', (_job, result) => logJobResult(name, result));
      worker.on('failed', (_job, err) => logger.error({ err, job: name }, 'Background job failed'));
      worker.on('error', (err) => logger.error({ err, job: name }, 'Background worker error'));
      workers.push(worker);
    }
  } catch (err) {
    await close();
    throw err;
  }

  logger.info({ jobs: JOB_NAMES }, 'Background jobs scheduled');
  return { queues, close };
}