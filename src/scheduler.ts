import type { Job } from "bullmq";
import { config } from "./config.js";
import { query } from "./db.js";
import { enqueueSms } from "./outbound.js";
import { getQueues, jobId } from "./queues.js";
import {
  addDays,
  avoidQuietHours,
  formatLocalDay,
  formatLocalTime,
  isQuietHour,
  localDateString,
  nextLocalOccurrence,
  zonedTimeToUtc,
  type Quiet,
} from "./time.js";

export function quiet(): Quiet {
  const c = config();
  return { enabled: c.QUIET_HOURS_ENABLED, start: c.QUIET_HOURS_START, end: c.QUIET_HOURS_END };
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

async function addDelayed(name: string, data: object, runAt: Date, id: string): Promise<void> {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  // A fixed job id makes this idempotent: asking twice for the same job schedules it once.
  await getQueues().schedule.add(name, data, { delay, jobId: id });
}

// ---------------------------------------------------------------- daily check-ins

type ContactRow = { id: number; name: string; timezone: string; opted_out: boolean };

async function loadContact(id: number): Promise<ContactRow | undefined> {
  const [c] = await query<ContactRow>("SELECT id, name, timezone, opted_out FROM contacts WHERE id = $1", [id]);
  return c;
}

/** Schedule the check-in for one specific local day, at the configured hour on that contact's clock. */
export async function scheduleCheckinFor(contact: Pick<ContactRow, "id" | "timezone">, localDate: string): Promise<void> {
  const runAt = zonedTimeToUtc(localDate, `${String(config().CHECKIN_HOUR).padStart(2, "0")}:00`, contact.timezone);
  await addDelayed("checkin", { contactId: contact.id, localDate }, runAt, jobId("checkin", contact.id, localDate));
}

/** The first (or next) check-in: today if the hour hasn't passed yet in their time zone, otherwise tomorrow. */
export async function scheduleNextCheckin(contactId: number): Promise<void> {
  const contact = await loadContact(contactId);
  if (!contact || contact.opted_out) return;
  const next = nextLocalOccurrence(new Date(), contact.timezone, config().CHECKIN_HOUR);
  await scheduleCheckinFor(contact, localDateString(next, contact.timezone));
}

/**
 * The daily check-in. Each one schedules the next day's before doing anything else, so a crash
 * half-way through can't end the chain. The unique (contact, date) row is what stops a double ask.
 */
export async function processCheckin(job: Job<{ contactId: number; localDate: string }>): Promise<{ skipped?: string }> {
  const { contactId, localDate } = job.data;
  const contact = await loadContact(contactId);
  if (!contact) return { skipped: "no_contact" };
  if (contact.opted_out) return { skipped: "opted_out" }; // no reschedule: opting out ends the chain

  await scheduleCheckinFor(contact, addDays(localDate, 1));

  const [row] = await query<{ id: number; status: string }>(
    `INSERT INTO checkins (contact_id, local_date, status, asked_at) VALUES ($1, $2, 'pending', now())
     ON CONFLICT (contact_id, local_date) DO UPDATE SET local_date = EXCLUDED.local_date
     RETURNING id, status`,
    [contactId, localDate],
  );
  // Already logged earlier today (they texted DONE before we asked): nothing to chase.
  if (!row || row.status !== "pending") return { skipped: "already_answered" };

  await enqueueSms({
    contactId,
    kind: "checkin",
    body: `Hi ${firstName(contact.name)}! Did you get your workout in today? Reply DONE, SKIP (rest day) or NO.`,
    dedupeKey: `checkin-${row.id}`,
  });

  const c = config();
  const askedAt = new Date();
  for (let n = 1; n <= c.MAX_NAGS; n++) {
    const runAt = new Date(askedAt.getTime() + n * c.NAG_DELAY_MINUTES * 60_000);
    // Never chase into the night, and never about yesterday.
    if (localDateString(runAt, contact.timezone) !== localDate) break;
    if (isQuietHour(runAt, contact.timezone, quiet())) break;
    await addDelayed("nag", { checkinId: row.id, n }, runAt, jobId("nag", row.id, n));
  }

  // At local midnight an unanswered day becomes a miss.
  await addDelayed("close", { checkinId: row.id }, zonedTimeToUtc(addDays(localDate, 1), "00:00", contact.timezone), jobId("close", row.id));
  return {};
}

export async function processNag(job: Job<{ checkinId: number; n: number }>): Promise<{ skipped?: string }> {
  const { checkinId, n } = job.data;
  const [row] = await query<{ status: string; contact_id: number; name: string; timezone: string; opted_out: boolean }>(
    `SELECT ch.status, c.id AS contact_id, c.name, c.timezone, c.opted_out
       FROM checkins ch JOIN contacts c ON c.id = ch.contact_id WHERE ch.id = $1`,
    [checkinId],
  );
  if (!row) return { skipped: "no_checkin" };
  if (row.opted_out) return { skipped: "opted_out" };
  if (row.status !== "pending") return { skipped: "already_answered" }; // they replied: the nag quietly does nothing
  if (isQuietHour(new Date(), row.timezone, quiet())) return { skipped: "quiet_hours" };

  const name = firstName(row.name);
  const body =
    n <= 1
      ? `Quick nudge, ${name}: no workout logged yet today. Reply DONE, SKIP or NO.`
      : `Last call for today, ${name}. Reply DONE once you've trained, or SKIP if it's a rest day.`;
  await enqueueSms({ contactId: row.contact_id, kind: "nag", body, dedupeKey: `nag-${checkinId}-${n}` });
  await query("UPDATE checkins SET nags_sent = GREATEST(nags_sent, $2) WHERE id = $1", [checkinId, n]);
  return {};
}

export async function processClose(job: Job<{ checkinId: number }>): Promise<void> {
  await query("UPDATE checkins SET status = 'missed' WHERE id = $1 AND status = 'pending'", [job.data.checkinId]);
}

// ---------------------------------------------------------------- session reminders

export type SessionInput = { id: string; date: string; startTime: string; focus?: string | null | undefined; timezone?: string | undefined };

const HOUR = 3_600_000;

/** Plan a "24 hours before" and a "2 hours before" text for a booked session. */
export async function scheduleReminders(contact: Pick<ContactRow, "id" | "timezone">, session: SessionInput): Promise<void> {
  const start = zonedTimeToUtc(session.date, session.startTime, session.timezone ?? contact.timezone);
  const now = Date.now();

  for (const [kind, lead] of [["24h", 24 * HOUR], ["2h", 2 * HOUR]] as const) {
    let sendAt = new Date(start.getTime() - lead);
    if (sendAt.getTime() <= now) continue; // too late for this one (booked less than 24h ahead, say)
    sendAt = avoidQuietHours(sendAt, contact.timezone, quiet());
    if (sendAt.getTime() >= start.getTime() - HOUR / 2) continue; // pushing it past quiet hours would leave no useful warning

    const [row] = await query<{ id: number; status: string }>(
      `INSERT INTO reminders (contact_id, session_id, kind, send_at, session_start, focus)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, kind) DO UPDATE SET status = reminders.status
       RETURNING id, status`,
      [contact.id, session.id, kind, sendAt, start, session.focus ?? null],
    );
    if (row && row.status === "scheduled") await addDelayed("reminder", { reminderId: row.id }, sendAt, jobId("rem", row.id));
  }
}

/** A cancelled session must not produce a reminder: mark them and pull the queued jobs. */
export async function cancelReminders(sessionId: string): Promise<number> {
  const rows = await query<{ id: number }>(
    "UPDATE reminders SET status = 'cancelled' WHERE session_id = $1 AND status = 'scheduled' RETURNING id",
    [sessionId],
  );
  for (const r of rows) {
    try {
      await getQueues().schedule.remove(jobId("rem", r.id));
    } catch {
      // The job is running right now; processReminder re-checks the status and will skip it.
    }
  }
  return rows.length;
}

export async function processReminder(job: Job<{ reminderId: number }>): Promise<{ skipped?: string }> {
  const [r] = await query<{
    id: number; status: string; kind: string; session_start: Date; focus: string | null;
    contact_id: number; name: string; timezone: string; opted_out: boolean;
  }>(
    `SELECT r.id, r.status, r.kind, r.session_start, r.focus, c.id AS contact_id, c.name, c.timezone, c.opted_out
       FROM reminders r JOIN contacts c ON c.id = r.contact_id WHERE r.id = $1`,
    [job.data.reminderId],
  );
  if (!r || r.status !== "scheduled") return { skipped: "not_scheduled" }; // cancelled, or already sent
  if (r.opted_out) {
    await query("UPDATE reminders SET status = 'skipped' WHERE id = $1", [r.id]);
    return { skipped: "opted_out" };
  }

  const what = r.focus ? `${r.focus.toLowerCase()} session` : "session";
  const when = formatLocalTime(r.session_start, r.timezone);
  const body =
    r.kind === "24h"
      ? `Reminder: your ${what} with Jay is ${formatLocalDay(r.session_start, r.timezone)} at ${when}. Reply HELP for commands.`
      : `Heads up, ${firstName(r.name)}: your ${what} with Jay starts at ${when}, about 2 hours from now.`;

  await enqueueSms({ contactId: r.contact_id, kind: "reminder", body, dedupeKey: `reminder-${r.id}` });
  await query("UPDATE reminders SET status = 'sent' WHERE id = $1 AND status = 'scheduled'", [r.id]);
  return {};
}
