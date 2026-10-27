// Creates the tables. `--reset` drops them first.
import pg from "pg";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
if (process.argv.includes("--reset")) {
  await client.query("DROP TABLE IF EXISTS events_seen, reminders, checkins, messages, contacts CASCADE");
  console.log("Dropped existing tables.");

  // Contact ids start again from 1, so jobs left in Redis from the old data (their ids contain the old
  // contact ids) would collide with the new ones. Clear this app's queue keys too.
  if (process.env.REDIS_URL) {
    const { Redis } = await import("ioredis");
    const redis = new Redis(process.env.REDIS_URL);
    const prefix = process.env.QUEUE_PREFIX ?? "nudge";
    let cursor = "0";
    let removed = 0;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
      cursor = next;
      if (keys.length) removed += await redis.del(...keys);
    } while (cursor !== "0");
    console.log(`Cleared ${removed} queue keys.`);
    redis.disconnect();
  }
}
await client.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
console.log("Schema ready.");
await client.end();
