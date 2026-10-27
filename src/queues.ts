import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

export const OUTBOUND = "outbound";
export const SCHEDULE = "schedule";

/** BullMQ needs `maxRetriesPerRequest: null` on the connection a Worker blocks on. */
export function createRedis(): Redis {
  return new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
}

type Queues = { connection: Redis; outbound: Queue; schedule: Queue };
let queues: Queues | undefined;

export function getQueues(): Queues {
  if (!queues) {
    const c = config();
    const connection = createRedis();
    const defaultJobOptions: JobsOptions = {
      attempts: c.RETRY_ATTEMPTS,
      backoff: { type: "exponential", delay: c.RETRY_BACKOFF_MS },
      // Keep finished jobs for a while: a finished job's id still blocks a duplicate from being added.
      removeOnComplete: { age: 2 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    };
    queues = {
      connection,
      outbound: new Queue(OUTBOUND, { connection, prefix: c.QUEUE_PREFIX, defaultJobOptions }),
      schedule: new Queue(SCHEDULE, { connection, prefix: c.QUEUE_PREFIX, defaultJobOptions }),
    };
  }
  return queues;
}

export async function closeQueues(): Promise<void> {
  if (queues) {
    await queues.outbound.close();
    await queues.schedule.close();
    queues.connection.disconnect();
    queues = undefined;
  }
}

/** BullMQ ids may not contain ":"; keep them to a safe alphabet. */
export function jobId(...parts: (string | number)[]): string {
  return parts.join("-").replace(/[^A-Za-z0-9_-]/g, "-");
}
