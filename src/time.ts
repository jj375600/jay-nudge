// Time-zone maths without a date library. Every "when should this text go out" question is
// answered in the contact's own time zone, then converted to a real UTC instant.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function localParts(d: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(d)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar date ("YYYY-MM-DD") it currently is in `tz`. */
export function localDateString(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Add whole days to a "YYYY-MM-DD" string (pure calendar maths, no DST involved). */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

function offsetMs(utcMs: number, tz: string): number {
  const p = localParts(new Date(utcMs), tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a wall-clock time in `tz` ("2026-10-23", "18:00") to the real UTC instant. */
export function zonedTimeToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm, ss] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!, ss ?? 0);
  // Two passes so the answer is right on either side of a daylight-saving change.
  const first = guess - offsetMs(guess, tz);
  return new Date(guess - offsetMs(first, tz));
}

/** The next time it will be `hour`:00 on the wall clock in `tz`, strictly after `now`. */
export function nextLocalOccurrence(now: Date, tz: string, hour: number): Date {
  const today = localDateString(now, tz);
  const time = `${pad(hour)}:00`;
  const candidate = zonedTimeToUtc(today, time, tz);
  if (candidate.getTime() > now.getTime()) return candidate;
  return zonedTimeToUtc(addDays(today, 1), time, tz);
}

/** Midnight at the end of the local day that contains `now`. */
export function endOfLocalDay(now: Date, tz: string): Date {
  return zonedTimeToUtc(addDays(localDateString(now, tz), 1), "00:00", tz);
}

export type Quiet = { enabled: boolean; start: number; end: number };

/** Quiet hours may wrap midnight (21:00 to 08:00). */
export function isQuietHour(d: Date, tz: string, q: Quiet): boolean {
  if (!q.enabled || q.start === q.end) return false;
  const h = localParts(d, tz).hour;
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

/** When the current quiet period ends, in `tz`. */
export function quietHoursEnd(d: Date, tz: string, q: Quiet): Date {
  return nextLocalOccurrence(d, tz, q.end);
}

/** `d`, or the end of quiet hours if `d` falls inside them. */
export function avoidQuietHours(d: Date, tz: string, q: Quiet): Date {
  return isQuietHour(d, tz, q) ? quietHoursEnd(d, tz, q) : d;
}

export function formatLocalTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
}

export function formatLocalDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
}
