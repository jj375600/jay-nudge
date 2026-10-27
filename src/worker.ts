import { Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { processOutbound } from "./outbound.js";
import { closeQueues, createRedis, OUTBOUND, SCHEDULE } from "./queues.js";
import { processCheckin, processClose, processNag, processReminder } from "./scheduler.js";

const c = config();
const log = (level: string, msg: string, extra: object = {}) => console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra }));

// Sending: gently rate limited, because Twilio's own limit is per number (about one text a second).
const outbound = new Worker(OUTBOUND, processOutbound, {
  connection: createRedis(),
  prefix: c.QUEUE_PREFIX,
  concurrency: 5,
  limiter: { max: Math.max(1, Math.round(c.SEND_RATE_PER_SEC)), duration: 1000 },
});

// Scheduling: check-ins, nudges, end-of-day closes and session reminders, each a delayed job.
const schedule = new Worker(
  SCHEDULE,
  async (job: Job) => {
    switch (job.name) {
      case "checkin": return processCheckin(job);
      case "nag": return processNag(job);
      case "close": return processClose(job);
      case "reminder": return processReminder(job);
      default: throw new Error(`unknown job ${job.name}`);
    }
  },
  { connection: createRedis(), prefix: c.QUEUE_PREFIX, concurrency: 5 },
);

for (const [name, w] of [["outbound", outbound], ["schedule", schedule]] as const) {
  w.on("failed", (job, err) => log("warn", "job failed", { queue: name, job: job?.name, id: job?.id, attempt: job?.attemptsMade, error: err.message }));
  w.on("error", (err) => log("error", "worker error", { queue: name, error: err.message }));
}
log("info", "workers started", { prefix: c.QUEUE_PREFIX });

async function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  await Promise.all([outbound.close(), schedule.close()]); // finishes the job in hand, takes no new ones
  await closeQueues();
  await closeDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
