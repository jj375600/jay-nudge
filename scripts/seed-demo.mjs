// Fills a LOCAL database with clearly fictional clients and two weeks of history, so the dashboard has something to show.
//   npm run demo:seed      (then open http://localhost:4000/admin and enter ADMIN_TOKEN)
// It only runs against a database on this computer, and it never sends any text.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
if (!/@(localhost|127\.0\.0\.1)(:|\/)/.test(url)) throw new Error("Refusing to add demo data to a database that isn't on this computer.");

const TZ = "America/New_York";
const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86_400_000));

// One character per day, oldest first, for the last 14 days. D = worked out, S = rest day, M = missed, . = no check-in yet.
const clients = [
  { id: "demo-1", name: "Maya Johnson", phone: "+15550100101", days: "DDDSDDMDDDDSDD" },
  { id: "demo-2", name: "Marcus Lee", phone: "+15550100102", days: "DMDDDSDDDDDDDD" },
  { id: "demo-3", name: "Priya Patel", phone: "+15550100103", days: "DDMMDDDSDDMDDS" },
  { id: "demo-4", name: "Devon Carter", phone: "+15550100104", days: "MMDDMDDDDMMDDM", optedOut: true },
  { id: "demo-5", name: "Sofia Ramirez", phone: "+15550100105", days: "......DDSDDDDD" },
];

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  await db.query("DELETE FROM contacts WHERE external_id LIKE 'demo-%'");
  for (const c of clients) {
    const { rows } = await db.query(
      "INSERT INTO contacts (external_id, name, phone, timezone, opted_out, opted_out_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [c.id, c.name, c.phone, TZ, Boolean(c.optedOut), c.optedOut ? new Date() : null],
    );
    const id = rows[0].id;
    for (let i = 0; i < 14; i++) {
      const ch = c.days[i];
      if (ch === ".") continue;
      const status = { D: "completed", S: "skipped", M: "missed" }[ch];
      await db.query("INSERT INTO checkins (contact_id, local_date, status) VALUES ($1,$2,$3)", [id, daysAgo(13 - i), status]);
    }
  }
  const sample = [
    ["outbound", "checkin", "sent", "Did you get your workout in today? Reply DONE, SKIP (rest day) or NO.", 0],
    ["inbound", "inbound", "received", "DONE", 1],
    ["outbound", "reply", "sent", "Logged. Streak: 5 days.", 2],
    ["outbound", "reminder", "delivered", "Reminder: Strength training tomorrow at 6:00 PM.", 3],
    ["outbound", "nag", "sent", "Quick nudge: did you get your workout in today?", 4],
    ["inbound", "inbound", "received", "STREAK", 5],
    ["outbound", "reply", "delivered", "Streak: 5 days. Best: 9. Last 7 days: 6.", 6],
  ];
  const { rows } = await db.query("SELECT id FROM contacts WHERE external_id IN ('demo-1','demo-2','demo-3') ORDER BY id");
  let n = 0;
  for (const [direction, kind, status, body, mins] of sample) {
    await db.query(
      "INSERT INTO messages (contact_id, direction, kind, body, status, created_at) VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' minutes')::interval)",
      [rows[n++ % rows.length].id, direction, kind, body, status, String(mins * 7)],
    );
  }
  console.log(`Added ${clients.length} demo clients. Open /admin and enter your ADMIN_TOKEN.`);
} finally {
  await db.end();
}
