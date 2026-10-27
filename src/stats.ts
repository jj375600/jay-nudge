import { query } from "./db.js";
import { addDays, localDateString } from "./time.js";

export type Stats = { current: number; best: number; last7: number };

/**
 * Streaks with window functions ("gaps and islands"). A running count of missed days gives every
 * row a group number; a streak is the completed days inside one group. A skipped (rest) day neither
 * adds to the streak nor breaks it, and a still-pending day is ignored.
 */
export async function getStats(contactId: number, timezone: string, now: Date = new Date()): Promise<Stats> {
  const today = localDateString(now, timezone);
  const sevenDaysAgo = addDays(today, -6);

  const [row] = await query<{ current: string; best: string }>(
    `WITH ordered AS (
       SELECT status,
              SUM((status = 'missed')::int) OVER (ORDER BY local_date) AS grp
         FROM checkins
        WHERE contact_id = $1 AND status <> 'pending'
     ), per_group AS (
       SELECT grp, COUNT(*) FILTER (WHERE status = 'completed') AS completed
         FROM ordered GROUP BY grp
     )
     SELECT COALESCE((SELECT completed FROM per_group ORDER BY grp DESC LIMIT 1), 0) AS current,
            COALESCE((SELECT MAX(completed) FROM per_group), 0) AS best`,
    [contactId],
  );

  const [recent] = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM checkins
      WHERE contact_id = $1 AND status = 'completed' AND local_date BETWEEN $2 AND $3`,
    [contactId, sevenDaysAgo, today],
  );

  return { current: Number(row?.current ?? 0), best: Number(row?.best ?? 0), last7: Number(recent?.n ?? 0) };
}
