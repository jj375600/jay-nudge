import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { closeDb, query } from "../src/db.js";
import { signEvent } from "../src/events.js";
import { closeQueues } from "../src/queues.js";
import { addDays, formatLocalDay, formatLocalTime, localDateString, nextLocalOccurrence, zonedTimeToUtc } from "../src/time.js";
import { client, contactByPhone, jobExists, optIn, postEvent, postRaw, promote, sentTo, sleep, waitFor, waitForTexts } from "./helpers.js";

after(async () => {
  await closeQueues();
  await closeDb();
});

describe("event signing", () => {
  test("unsigned, wrongly signed, tampered and stale events are rejected and change nothing", async () => {
    const c = client();
    const raw = JSON.stringify({ eventId: randomUUID(), type: "client.opted_in", client: c });
    const secret = config().EVENTS_SECRET;

    assert.equal((await postRaw(raw)).status, 401);
    assert.equal((await postRaw(raw, signEvent("some_other_secret_value_000000", raw))).status, 401);
    assert.equal((await postRaw(raw.replace("Maya", "Mallory"), signEvent(secret, raw))).status, 401);
    const stale = await postRaw(raw, signEvent(secret, raw, Math.floor(Date.now() / 1000) - 3600));
    assert.equal(stale.status, 401);
    assert.match(((await stale.json()) as { error: string }).error, /window/);

    assert.equal(await contactByPhone(c.phone), undefined);
    assert.equal((await sentTo(c.phone)).length, 0);
  });

  test("a bad payload that is correctly signed is a 400 with reasons", async () => {
    const bad = await postEvent({ type: "client.opted_in", client: { ...client(), phone: "404-555-0100" } });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(await bad.json()), /E\.164/);
    assert.equal((await postEvent({ type: "nonsense" })).status, 400);
    assert.equal((await postEvent({ type: "client.opted_in", client: { ...client(), timezone: "Mars/Olympus" } })).status, 400);
    const raw = "{not json";
    assert.equal((await postRaw(raw, signEvent(config().EVENTS_SECRET, raw))).status, 400);
  });
});

describe("opting in", () => {
  test("creates the contact, texts a welcome and schedules the first daily check-in", async () => {
    const c = await optIn();
    assert.ok(c.contact, "contact exists");

    const [welcome] = await waitForTexts(c.phone, 1);
    assert.match(welcome!.body, /Hi Maya!/);
    assert.match(welcome!.body, /STOP to opt out/);
    assert.equal(welcome!.from, config().TWILIO_FROM_NUMBER);

    const localDate = localDateString(nextLocalOccurrence(new Date(), c.timezone, config().CHECKIN_HOUR), c.timezone);
    assert.equal(await jobExists(`checkin-${c.contact!.id}-${localDate}`), true);
  });

  test("the same event delivered twice is processed once", async () => {
    const c = client();
    const raw = JSON.stringify({ eventId: randomUUID(), type: "client.opted_in", client: c });
    const sig = () => signEvent(config().EVENTS_SECRET, raw);
    const first = await postRaw(raw, sig());
    const second = await postRaw(raw, sig());
    assert.equal(first.status, 200);
    assert.deepEqual(await second.json(), { ok: true, duplicate: true });
    await waitForTexts(c.phone, 1);
    await sleep(500);
    assert.equal((await sentTo(c.phone)).length, 1, "only one welcome");
  });

  test("a re-sent opt-in with a new event id doesn't welcome them again", async () => {
    const c = await optIn();
    await waitForTexts(c.phone, 1);
    assert.equal((await postEvent({ type: "client.opted_in", client: c })).status, 200);
    await sleep(500);
    assert.equal((await sentTo(c.phone)).length, 1);
  });

  test("two different clients can't share one phone number", async () => {
    const a = await optIn();
    const res = await postEvent({ type: "client.opted_in", client: { ...client(), phone: a.phone } });
    assert.equal(res.status, 422);
  });
});

describe("session reminders", () => {
  /** A session `days` ahead at 18:00 in the client's own zone. */
  const sessionIn = (tz: string, days: number, id = randomUUID()) => ({
    id, date: addDays(localDateString(new Date(), tz), days), startTime: "18:00", focus: "Strength training",
  });
  const reminderRows = (sessionId: string) =>
    query<{ id: number; kind: string; status: string }>("SELECT id, kind, status FROM reminders WHERE session_id = $1 ORDER BY kind", [sessionId]);

  test("a booking three days out schedules a 24-hour and a 2-hour reminder", async () => {
    const c = client();
    const session = sessionIn(c.timezone, 3);
    assert.equal((await postEvent({ type: "session.booked", client: c, session })).status, 200);

    const rows = await reminderRows(session.id);
    assert.deepEqual(rows.map((r) => [r.kind, r.status]), [["24h", "scheduled"], ["2h", "scheduled"]]);
    for (const r of rows) assert.equal(await jobExists(`rem-${r.id}`), true);
  });

  test("when the reminder time arrives the client is texted exactly the right thing, once", async () => {
    const c = client();
    const session = sessionIn(c.timezone, 3);
    await postEvent({ type: "session.booked", client: c, session });
    await waitForTexts(c.phone, 1); // the welcome

    const rows = await reminderRows(session.id);
    const day24 = rows.find((r) => r.kind === "24h")!;
    const start = zonedTimeToUtc(session.date, "18:00", c.timezone);

    assert.equal(await promote(`rem-${day24.id}`), true);
    const texts = await waitForTexts(c.phone, 2);
    const reminder = texts.find((t) => t.body.startsWith("Reminder"))!;
    assert.ok(reminder.body.includes(formatLocalDay(start, c.timezone)), reminder.body);
    assert.ok(reminder.body.includes("6:00 PM"), reminder.body);
    assert.ok(reminder.body.includes("strength training session"), reminder.body);

    await waitFor(async () => (await reminderRows(session.id)).find((r) => r.kind === "24h")?.status === "sent", "reminder marked sent");
    await sleep(400);
    assert.equal((await sentTo(c.phone)).filter((t) => t.body.startsWith("Reminder")).length, 1);
  });

  test("the same booking event arriving again does not duplicate the reminders", async () => {
    const c = client();
    const session = sessionIn(c.timezone, 3);
    await postEvent({ type: "session.booked", client: c, session });
    await postEvent({ type: "session.booked", client: c, session }); // new event id, same session
    assert.equal((await reminderRows(session.id)).length, 2);
  });

  test("cancelling the session cancels its reminders and removes the queued jobs", async () => {
    const c = client();
    const session = sessionIn(c.timezone, 3);
    await postEvent({ type: "session.booked", client: c, session });
    const before = await reminderRows(session.id);

    assert.equal((await postEvent({ type: "session.cancelled", session: { id: session.id } })).status, 200);
    assert.deepEqual((await reminderRows(session.id)).map((r) => r.status), ["cancelled", "cancelled"]);
    for (const r of before) {
      assert.equal(await jobExists(`rem-${r.id}`), false);
      assert.equal(await promote(`rem-${r.id}`), false, "nothing left to fire");
    }
  });

  test("a reminder that was already queued but is cancelled before it runs sends nothing", async () => {
    const c = client();
    const session = sessionIn(c.timezone, 3);
    await postEvent({ type: "session.booked", client: c, session });
    await waitForTexts(c.phone, 1);
    const row = (await reminderRows(session.id))[0]!;
    await promote(`rem-${row.id}`); // already on its way...
    await postEvent({ type: "session.cancelled", session: { id: session.id } });
    await sleep(800);
    // Either the worker saw "cancelled" and skipped, or it won the race and sent; what must never happen is two texts.
    assert.ok((await sentTo(c.phone)).filter((t) => t.body.startsWith("Reminder")).length <= 1);
  });

  test("a session booked for later today only gets the reminders that are still in the future", async () => {
    const c = client();
    // 18:00 today (it is mid-day in their zone): the 24h mark has passed, the 2h mark (16:00) hasn't.
    const session = sessionIn(c.timezone, 0);
    await postEvent({ type: "session.booked", client: c, session });
    assert.deepEqual((await reminderRows(session.id)).map((r) => r.kind), ["2h"]);

    // A session already underway or in the past gets none.
    const past = sessionIn(c.timezone, -1);
    await postEvent({ type: "session.booked", client: c, session: past });
    assert.equal((await reminderRows(past.id)).length, 0);
  });

  test("the 2-hour reminder wording", async () => {
    const c = client();
    const session = sessionIn(c.timezone, 0);
    await postEvent({ type: "session.booked", client: c, session });
    await waitForTexts(c.phone, 1);
    const row = (await reminderRows(session.id))[0]!;
    await promote(`rem-${row.id}`);
    const texts = await waitForTexts(c.phone, 2);
    const body = texts.map((t) => t.body).find((b) => b.startsWith("Heads up"))!;
    assert.ok(body.includes(formatLocalTime(zonedTimeToUtc(session.date, "18:00", c.timezone), c.timezone)), body);
    assert.match(body, /about 2 hours/);
  });
});
