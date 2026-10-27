import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeQueues } from "./queues.js";

const app = await buildApp();
await app.listen({ port: config().PORT, host: "0.0.0.0" });

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await closeQueues();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
