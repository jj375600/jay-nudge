import { timingSafeEqual } from "node:crypto";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import { getSummary } from "./admin.js";
import { DASHBOARD_CSP, DASHBOARD_HTML } from "./dashboard.js";
import { db, maskPhone, query } from "./db.js";
import { eventSchema, verifyEventSignature } from "./events.js";
import { handleEvent, handleInbound, PhoneInUseError } from "./handlers.js";
import { getQueues } from "./queues.js";
import { verifyTwilioSignature } from "./twilio.js";

const EMPTY_TWIML = "<Response></Response>";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Form bodies arrive as { key: string | string[] }; Twilio's signature wants plain strings. */
function flatten(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) out[k] = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  return out;
}

export async function buildApp(): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 64 * 1024, trustProxy: true });
  await app.register(formbody);

  app.get("/health", async (_req, reply) => {
    try {
      await query("SELECT 1");
      await getQueues().connection.ping();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ---- signed events from JAY-AESTHETIX. Its own scope so the body stays a raw string: the signature covers exact bytes.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

    scope.post("/events", async (req, reply) => {
      const raw = req.body as string;
      const verdict = verifyEventSignature(c.EVENTS_SECRET, raw, req.headers["x-nudge-signature"] as string | undefined);
      if (verdict !== "ok") return reply.code(401).send({ error: verdict === "stale" ? "timestamp outside the allowed window" : "invalid signature" });

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "body is not valid JSON" });
      }
      const parsed = eventSchema.safeParse(json);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid event", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) });
      }
      const event = parsed.data;

      // The sender retries on any non-2xx, so the same event id must be harmless the second time.
      const fresh = await query("INSERT INTO events_seen (event_id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id", [event.eventId, event.type]);
      if (fresh.length === 0) return { ok: true, duplicate: true };

      try {
        await handleEvent(event);
      } catch (err) {
        await query("DELETE FROM events_seen WHERE event_id = $1", [event.eventId]); // let the retry run for real
        if (err instanceof PhoneInUseError) return reply.code(422).send({ error: err.message });
        throw err;
      }
      return { ok: true };
    });
  });

  // ---- Twilio webhooks: always verify the signature first.
  app.post("/webhooks/twilio/inbound", async (req, reply) => {
    const params = flatten(req.body);
    const ok = verifyTwilioSignature(c.TWILIO_AUTH_TOKEN, c.PUBLIC_BASE_URL + req.url, params, req.headers["x-twilio-signature"] as string | undefined);
    if (!ok) return reply.code(403).send({ error: "bad signature" });
    if (!params.From || !params.MessageSid) return reply.code(400).send({ error: "missing From or MessageSid" });

    const result = await handleInbound({ from: params.From, body: params.Body ?? "", sid: params.MessageSid });
    req.log.info({ from: maskPhone(params.From), handled: result.handled, reason: result.reason }, "inbound text");
    // An empty TwiML reply: any answer goes out through the outbound queue, so it is rate-limited and logged like every other text.
    return reply.type("text/xml").send(EMPTY_TWIML);
  });

  app.post("/webhooks/twilio/status", async (req, reply) => {
    const params = flatten(req.body);
    const ok = verifyTwilioSignature(c.TWILIO_AUTH_TOKEN, c.PUBLIC_BASE_URL + req.url, params, req.headers["x-twilio-signature"] as string | undefined);
    if (!ok) return reply.code(403).send({ error: "bad signature" });

    const status = ({ delivered: "delivered", undelivered: "undelivered", failed: "failed" } as Record<string, string>)[params.MessageStatus ?? ""];
    // Only the end states matter; "queued/sent" callbacks must not move a delivered message backwards.
    if (status && params.MessageSid) {
      await query("UPDATE messages SET status = $2, error = COALESCE($3, error) WHERE twilio_sid = $1", [params.MessageSid, status, params.ErrorCode ? `Twilio error ${params.ErrorCode}` : null]);
    }
    return reply.type("text/xml").send(EMPTY_TWIML);
  });

  // ---- a small read-only view for the owner. The page holds no data; the data comes from /admin/summary with the token.
  app.get("/admin", async (_req, reply) =>
    reply
      .header("content-security-policy", DASHBOARD_CSP)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(DASHBOARD_HTML),
  );

  app.get("/admin/summary", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), c.ADMIN_TOKEN)) return reply.code(401).send({ error: "unauthorized" });

    return getSummary();
  });

  app.addHook("onClose", async () => {
    await db().end().catch(() => undefined);
  });
  return app;
}
