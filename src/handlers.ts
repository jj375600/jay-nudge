import { parseCommand } from "./commands.js";
import { config } from "./config.js";
import { maskPhone, query } from "./db.js";
import type { NudgeEvent } from "./events.js";
import { enqueueSms } from "./outbound.js";
import { cancelReminders, firstName, scheduleNextCheckin, scheduleReminders } from "./scheduler.js";
import { getStats } from "./stats.js";
import { localDateString } from "./time.js";

type Contact = { id: number; name: string; timezone: string; opted_out: boolean };

// ---------------------------------------------------------------- events from JAY-AESTHETIX

type ClientInput = { id: string; name: string; phone: string; timezone?: string | undefined };

/** Create or update the contact. Returns whether this is the first time we've seen them. */
async function upsertContact(client: ClientInput): Promise<{ contact: Contact; created: boolean }> {
  const [row] = await query<Contact & { created: boolean }>(
    `INSERT INTO contacts (external_id, name, phone, timezone)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (external_id) DO UPDATE
       SET name = EXCLUDED.name, phone = EXCLUDED.phone, timezone = EXCLUDED.timezone
     RETURNING id, name, timezone, opted_out, (xmax = 0) AS created`,
    [client.id, client.name, client.phone, client.timezone ?? config().DEFAULT_TIMEZONE],
  );
  if (!row) throw new Error("contact upsert returned nothing");
  return { contact: row, created: row.created };
}

export class PhoneInUseError extends Error {}

export async function handleEvent(event: NudgeEvent): Promise<void> {
  try {
    switch (event.type) {
      case "client.opted_in":
      case "session.booked": {
        const { contact, created } = await upsertContact(event.client);
        if (created) {
          await enqueueSms({
            contactId: contact.id,
            kind: "welcome",
            body: `JAY-AESTHETIX: Hi ${firstName(contact.name)}! You'll get session reminders and a daily workout check-in. Reply HELP for commands, STOP to opt out. Msg&data rates may apply.`,
            dedupeKey: `welcome-${contact.id}`,
          });
          await scheduleNextCheckin(contact.id);
        }
        if (event.type === "session.booked" && !contact.opted_out) await scheduleReminders(contact, event.session);
        return;
      }
      case "session.cancelled":
        await cancelReminders(event.session.id);
        return;
    }
  } catch (err) {
    // 23505 on the phone column: two different clients registered the same number.
    if ((err as { code?: string }).code === "23505") throw new PhoneInUseError("that phone number belongs to another client");
    throw err;
  }
}

// ---------------------------------------------------------------- texts from clients

const HELP_TEXT = "Reply DONE after a workout, SKIP for a rest day, NO if you missed, STREAK for your stats, STOP to opt out.";

async function reply(contactId: number, kind: string, body: string, dedupeKey: string): Promise<void> {
  await enqueueSms({ contactId, kind, body, dedupeKey });
}

type Logged = "logged" | "already" | "locked";

/** Record today's result for this contact. A reply counts for the day (in their time zone) it arrives. */
async function logToday(contact: Contact, status: "completed" | "skipped" | "missed"): Promise<Logged> {
  const today = localDateString(new Date(), contact.timezone);
  const [existing] = await query<{ status: string }>(
    "SELECT status FROM checkins WHERE contact_id = $1 AND local_date = $2",
    [contact.id, today],
  );
  if (existing?.status === status) return "already";
  if (existing?.status === "completed") return "locked"; // a logged workout isn't taken back by a later "no"
  await query(
    `INSERT INTO checkins (contact_id, local_date, status, replied_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (contact_id, local_date) DO UPDATE SET status = EXCLUDED.status, replied_at = now()`,
    [contact.id, today, status],
  );
  return "logged";
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Handle one inbound text. `sid` is Twilio's message id, used so a retried webhook is processed once. */
export async function handleInbound(input: { from: string; body: string; sid: string }): Promise<{ handled: boolean; reason?: string }> {
  const [contact] = await query<Contact>(
    "SELECT id, name, timezone, opted_out FROM contacts WHERE phone = $1",
    [input.from],
  );

  // Record it (once). A retry of the same webhook hits the unique twilio_sid and stops here.
  const inserted = await query(
    `INSERT INTO messages (contact_id, direction, kind, body, status, twilio_sid)
     VALUES ($1, 'inbound', 'inbound', $2, 'received', $3)
     ON CONFLICT (twilio_sid) DO NOTHING RETURNING id`,
    [contact?.id ?? null, input.body.slice(0, 1000), input.sid],
  );
  if (inserted.length === 0) return { handled: false, reason: "duplicate" };
  if (!contact) return { handled: false, reason: `unknown_number ${maskPhone(input.from)}` };

  const command = parseCommand(input.body);
  const key = `reply-${input.sid}`;

  if (command === "stop") {
    await query("UPDATE contacts SET opted_out = TRUE, opted_out_at = now() WHERE id = $1", [contact.id]);
    return { handled: true }; // Twilio sends its own opt-out confirmation; adding ours would be a second text
  }

  if (contact.opted_out) {
    if (command === "start" || command === "yes") {
      await query("UPDATE contacts SET opted_out = FALSE, opted_out_at = NULL WHERE id = $1", [contact.id]);
      await scheduleNextCheckin(contact.id);
      await reply(contact.id, "start_confirm", `Welcome back, ${firstName(contact.name)}! Reply HELP for commands or STOP to opt out.`, key);
      return { handled: true };
    }
    return { handled: false, reason: "opted_out" };
  }

  switch (command) {
    case "done":
    case "yes": {
      const result = await logToday(contact, "completed");
      const s = await getStats(contact.id, contact.timezone);
      const text =
        result === "already" || result === "locked"
          ? `Already logged today. Streak: ${days(s.current)}.`
          : `Logged. Nice work, ${firstName(contact.name)}! Streak: ${days(s.current)}.`;
      await reply(contact.id, "reply", text, key);
      return { handled: true };
    }
    case "skip": {
      const result = await logToday(contact, "skipped");
      const s = await getStats(contact.id, contact.timezone);
      await reply(contact.id, "reply", result === "locked" ? `You already logged a workout today. Streak: ${days(s.current)}.` : `Rest day logged. Your streak is safe at ${days(s.current)}.`, key);
      return { handled: true };
    }
    case "no": {
      const result = await logToday(contact, "missed");
      const s = await getStats(contact.id, contact.timezone);
      await reply(contact.id, "reply", result === "locked" ? `You already logged a workout today. Streak: ${days(s.current)}.` : "Logged. Tomorrow is a fresh start.", key);
      return { handled: true };
    }
    case "streak": {
      const s = await getStats(contact.id, contact.timezone);
      await reply(contact.id, "reply", `Streak: ${days(s.current)}. Best: ${days(s.best)}. Last 7 days: ${s.last7} workout${s.last7 === 1 ? "" : "s"}.`, key);
      return { handled: true };
    }
    case "start":
      await reply(contact.id, "reply", "You're already subscribed. Reply HELP for commands.", key);
      return { handled: true };
    case "help":
      await reply(contact.id, "reply", HELP_TEXT, key);
      return { handled: true };
    default: {
      // At most one "didn't understand" reply an hour, so two bots can never get stuck answering each other.
      const hour = Math.floor(Date.now() / 3_600_000);
      await reply(contact.id, "reply", `Sorry, I didn't get that. ${HELP_TEXT}`, `unknown-${contact.id}-${hour}`);
      return { handled: true };
    }
  }
}
