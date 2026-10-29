import { maskPhone, query } from "./db.js";
import { getQueues } from "./queues.js";
import { getStats } from "./stats.js";
import { addDays, localDateString } from "./time.js";

const DAYS = 14;
const CLIENT_LIMIT = 25;

export type DayStatus = "completed" | "skipped" | "missed" | "pending" | "none";

/**
 * Everything the owner's dashboard shows. Read-only, and it never contains a full phone number or a last name:
 * clients appear as a first name and "***1234".
 */
export async function getSummary(now: Date = new Date()) {
  const [contacts] = await query<{ total: string; opted_out: string }>(
    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE opted_out) AS opted_out FROM contacts",
  );
  const messages = await query<{ status: string; n: string }>(
    "SELECT status, COUNT(*) AS n FROM messages WHERE created_at > now() - interval '24 hours' GROUP BY status",
  );
  const checkins = await query<{ status: string; n: string }>(
    "SELECT status, COUNT(*) AS n FROM checkins WHERE local_date >= (now() - interval '1 day')::date GROUP BY status",
  );
  const recent = await query<{ direction: string; kind: string; status: string; body: string; phone: string | null; created_at: Date }>(
    `SELECT m.direction, m.kind, m.status, m.body, c.phone, m.created_at
       FROM messages m LEFT JOIN contacts c ON c.id = m.contact_id ORDER BY m.id DESC LIMIT 12`,
  );
  const queue = await getQueues().schedule.getJobCounts("delayed", "waiting", "active", "failed");

  const people = await query<{ id: number; name: string; phone: string; timezone: string; opted_out: boolean }>(
    "SELECT id, name, phone, timezone, opted_out FROM contacts ORDER BY id DESC LIMIT $1",
    [CLIENT_LIMIT],
  );
  const clients = await Promise.all(
    people.map(async (p) => {
      const today = localDateString(now, p.timezone);
      const from = addDays(today, -(DAYS - 1));
      const rows = await query<{ local_date: string; status: string }>(
        "SELECT local_date::text AS local_date, status FROM checkins WHERE contact_id = $1 AND local_date BETWEEN $2 AND $3",
        [p.id, from, today],
      );
      const byDate = new Map(rows.map((r) => [r.local_date, r.status as DayStatus]));
      const days: DayStatus[] = Array.from({ length: DAYS }, (_, i) => byDate.get(addDays(from, i)) ?? "none");
      return {
        name: p.name.trim().split(/\s+/)[0] ?? "Client",
        phone: maskPhone(p.phone),
        timezone: p.timezone,
        optedOut: p.opted_out,
        ...(await getStats(p.id, p.timezone, now)),
        days,
      };
    }),
  );

  return {
    contacts: { total: Number(contacts?.total ?? 0), optedOut: Number(contacts?.opted_out ?? 0) },
    messagesLast24h: Object.fromEntries(messages.map((m) => [m.status, Number(m.n)])),
    checkinsRecent: Object.fromEntries(checkins.map((m) => [m.status, Number(m.n)])),
    scheduleQueue: queue,
    clients,
    recent: recent.map((m) => ({ ...m, body: m.body.slice(0, 140), phone: m.phone ? maskPhone(m.phone) : null })),
  };
}
