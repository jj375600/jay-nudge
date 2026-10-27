import { UnrecoverableError, type Job } from "bullmq";
import { query } from "./db.js";
import { getQueues, jobId } from "./queues.js";
import { sendSms, TwilioError, TWILIO_UNSUBSCRIBED } from "./twilio.js";

export type OutboundJob = { contactId: number; kind: string; body: string; dedupeKey: string };

/**
 * Every text goes through this queue, never straight to Twilio. That gives one place for rate
 * limiting, retries and the "never text someone who opted out" rule.
 * `dedupeKey` makes it safe to ask twice: the same key is sent at most once.
 */
export async function enqueueSms(input: OutboundJob): Promise<void> {
  await getQueues().outbound.add("sms", input, { jobId: jobId("sms", input.dedupeKey) });
}

export async function processOutbound(job: Job<OutboundJob>): Promise<{ sid?: string; skipped?: string }> {
  const { contactId, kind, body, dedupeKey } = job.data;

  const [contact] = await query<{ id: number; phone: string; opted_out: boolean }>(
    "SELECT id, phone, opted_out FROM contacts WHERE id = $1",
    [contactId],
  );
  if (!contact) return { skipped: "no_contact" };
  // The one message allowed to an opted-out number is the confirmation that they just opted back in.
  if (contact.opted_out && kind !== "start_confirm") return { skipped: "opted_out" };

  // Record intent first. If this job is retried after a crash, the same row is found again.
  const [row] = await query<{ id: number; status: string }>(
    `INSERT INTO messages (contact_id, direction, kind, body, status, dedupe_key)
     VALUES ($1, 'outbound', $2, $3, 'sending', $4)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET status = CASE WHEN messages.status IN ('sent', 'delivered', 'undelivered') THEN messages.status ELSE 'sending' END
     RETURNING id, status`,
    [contactId, kind, body, dedupeKey],
  );
  if (!row || row.status !== 'sending') return { skipped: "already_sent" };

  try {
    const res = await sendSms({ to: contact.phone, body });
    await query(
      `UPDATE messages SET twilio_sid = $2, error = NULL,
              status = CASE WHEN status = 'sending' THEN 'sent' ELSE status END
        WHERE id = $1`,
      [row.id, res.sid],
    );
    return { sid: res.sid };
  } catch (err) {
    if (!(err instanceof TwilioError)) throw err;

    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (err.code === TWILIO_UNSUBSCRIBED) {
      // They replied STOP to Twilio directly. Respect it everywhere from now on.
      await query("UPDATE contacts SET opted_out = TRUE, opted_out_at = now() WHERE id = $1 AND NOT opted_out", [contactId]);
    }
    if (!err.retryable || finalAttempt) {
      await query("UPDATE messages SET status = 'failed', error = $2 WHERE id = $1", [row.id, err.message.slice(0, 300)]);
    }
    // A bad number or bad credentials will not fix themselves, so don't burn retries on them.
    if (!err.retryable) throw new UnrecoverableError(err.message);
    throw err;
  }
}
