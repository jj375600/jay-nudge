import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  PORT: z.coerce.number().int().default(4000),
  // The public URL Twilio calls. It is part of Twilio's signature, so it must match exactly.
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),

  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_FROM_NUMBER: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  TWILIO_API_BASE: z.string().url().default("https://api.twilio.com"),

  // Shared secret with JAY-AESTHETIX for signed booking events.
  EVENTS_SECRET: z.string().min(16),
  ADMIN_TOKEN: z.string().min(16),

  DEFAULT_TIMEZONE: z.string().default("America/New_York"),
  CHECKIN_HOUR: z.coerce.number().int().min(0).max(23).default(18),
  NAG_DELAY_MINUTES: z.coerce.number().positive().default(90),
  MAX_NAGS: z.coerce.number().int().min(0).max(5).default(2),

  QUIET_HOURS_ENABLED: bool.default(true),
  QUIET_HOURS_START: z.coerce.number().int().min(0).max(23).default(21),
  QUIET_HOURS_END: z.coerce.number().int().min(0).max(23).default(8),

  QUEUE_PREFIX: z.string().default("nudge"),
  SEND_RATE_PER_SEC: z.coerce.number().positive().default(1),
  RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(10).default(5000),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid configuration: ${problems}`);
    }
    cached = parsed.data;
  }
  return cached;
}
