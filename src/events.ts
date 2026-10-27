import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isValidTimezone } from "./time.js";

/**
 * Events from JAY-AESTHETIX are signed like Stripe webhooks:
 *   X-Nudge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 * The timestamp is inside the signed text, so a captured request can't be replayed later.
 */
export function signEvent(secret: string, rawBody: string, t: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export type SignatureResult = "ok" | "invalid" | "stale";

export function verifyEventSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): SignatureResult {
  if (!header) return "invalid";
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1) return "invalid";

  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const got = Buffer.from(v1);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return "invalid";
  return Math.abs(nowSeconds - t) > toleranceSeconds ? "stale" : "ok";
}

const id = z.union([z.string().min(1).max(64), z.number().int()]).transform(String);
const timezone = z.string().refine(isValidTimezone, "unknown time zone");

const client = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "phone must be E.164, like +14045550123"),
  timezone: timezone.optional(),
});

const session = z.object({
  id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  focus: z.string().trim().max(100).nullish(),
  timezone: timezone.optional(),
});

const base = { eventId: z.string().min(1).max(128) };

export const eventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("client.opted_in"), client }),
  z.object({ ...base, type: z.literal("session.booked"), client, session }),
  z.object({ ...base, type: z.literal("session.cancelled"), session: z.object({ id }) }),
]);

export type NudgeEvent = z.infer<typeof eventSchema>;
