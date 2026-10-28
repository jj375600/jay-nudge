import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { closeDb, query } from "../src/db.js";
import { closeQueues } from "../src/queues.js";
import { addDays, localDateString, nextLocalOccurrence } from "../src/time.js";
import { client, contactByPhone, inbound, jobExists, optIn, postEvent, promote, sentTo, sleep, waitFor, waitForTexts } from "./helpers.js";

after(async () => {
  await closeQueues();
  await closeDb();
});

async function begin() {
  const c = await optIn();
  await waitForTexts(c.phone, 1);
  const id = c.contact!.id;
  const localDate = localDateString(nextLocalOccurrence(new Date(), c.timezone, config().CHECKIN_HOUR), c.timezone);
  return { ...c, id, localDate, ev: { id: c.id, name: c.name, phone: c.phone, timezone: c.timezone } };
}

const optedOut = async (phone: string) => (await contactByPhone(phone))!.opted_out;

describe("STOP", () => {
  test("opts the client out immediately and sends nothing back", async () => {
    const c = await begin();
    await inbound(c.phone, "STOP");
    await waitFor(() => optedOut(c.phone), "opted out");
    const [row] = await query<{ opted_out_at: Date | null }>("SELECT opted_out_at FROM contacts WHERE id = $1", [c.id]);
    assert.ok(row!.opted_out_at, "the time is recorded");
    await sleep(500);
    assert.equal((await sentTo(c.phone)).length, 1, "only the welcome: Twilio sends its own opt-out confirmation");
  });

  test("is honoured inside a sentence", async () => {
    const c = await begin();
    await inbound(c.phone, "please stop texting me");
    await waitFor(() => optedOut(c.phone), "opted out");
  });

  test("ends the check-in chain: the next check-in asks nothing and schedules nothing further", async () => {
    const c = await begin();
    await inbound(c.phone, "stop");
    await waitFor(() => optedOut(c.phone), "opted out");

    assert.equal(await promote(`checkin-${c.id}-${c.localDate}`), true);
    await sleep(800);
    assert.equal((await sentTo(c.phone)).length, 1, "no question sent");
    assert.equal(await jobExists(`checkin-${c.id}-${addDays(c.localDate, 1)}`), false, "and the chain has ended");
  });

  test("a reminder that was already scheduled is skipped, not sent", async () => {
    const c = client();
    const session = { id: randomUUID(), date: addDays(localDateString(new Date(), c.timezone), 3), startTime: "18:00", focus: "Strength training" };
    await postEvent({ type: "session.booked", client: c, session });
    await waitForTexts(c.phone, 1);
    const [r] = await query<{ id: number }>("SELECT id FROM reminders WHERE session_id = $1 AND kind = '24h'", [session.id]);

    await inbound(c.phone, "stop");
    await waitFor(() => optedOut(c.phone), "opted out");
    await promote(`rem-${r!.id}`);
    await waitFor(async () => (await query<{ status: string }>("SELECT status FROM reminders WHERE id = $1", [r!.id]))[0]!.status === "skipped", "reminder skipped");
    assert.equal((await sentTo(c.phone)).length, 1);
  });

  test("a new booking for someone who opted out schedules no reminders", async () => {
    const c = await begin();
    await inbound(c.phone, "stop");
    await waitFor(() => optedOut(c.phone), "opted out");

    const session = { id: randomUUID(), date: addDays(localDateString(new Date(), c.timezone), 3), startTime: "18:00" };
    assert.equal((await postEvent({ type: "session.booked", client: c.ev, session })).status, 200);
    const rows = await query("SELECT 1 FROM reminders WHERE session_id = $1", [session.id]);
    assert.equal(rows.length, 0);
  });

  test("a website opt-in event can't override a STOP: only the person texting START can", async () => {
    const c = await begin();
    await inbound(c.phone, "stop");
    await waitFor(() => optedOut(c.phone), "opted out");
    assert.equal((await postEvent({ type: "client.opted_in", client: c.ev })).status, 200);
    assert.equal(await optedOut(c.phone), true);
  });

  test("any other text from an opted-out number gets no reply", async () => {
    const c = await begin();
    await inbound(c.phone, "stop");
    await waitFor(() => optedOut(c.phone), "opted out");
    await inbound(c.phone, "done");
    await inbound(c.phone, "hello");
    await sleep(600);
    assert.equal((await sentTo(c.phone)).length, 1);
    const checkins = await query("SELECT 1 FROM checkins WHERE contact_id = $1", [c.id]);
    assert.equal(checkins.length, 0, "and nothing is logged");
  });
});

describe("START", () => {
  test("opts them back in, confirms, and restarts the daily check-ins", async () => {
    const c = await begin();
    await inbound(c.phone, "stop");
    await waitFor(() => optedOut(c.phone), "opted out");

    await inbound(c.phone, "START");
    const texts = await waitForTexts(c.phone, 2);
    assert.match(texts[1]!.body, /Welcome back, Maya/);
    assert.equal(await optedOut(c.phone), false);
    assert.equal(await jobExists(`checkin-${c.id}-${c.localDate}`), true, "check-ins are scheduled again");
  });

  test("so does YES, which is Twilio's own opt-in keyword", async () => {
    const c = await begin();
    await inbound(c.phone, "stop");
    await waitFor(() => optedOut(c.phone), "opted out");
    await inbound(c.phone, "yes");
    await waitForTexts(c.phone, 2);
    assert.equal(await optedOut(c.phone), false);
  });

  test("START from someone already subscribed just says so", async () => {
    const c = await begin();
    await inbound(c.phone, "start");
    const texts = await waitForTexts(c.phone, 2);
    assert.match(texts[1]!.body, /already subscribed/);
  });
});

describe("opting out on the website", () => {
  test("client.opted_out stops reminders and the check-in chain, like STOP", async () => {
    const c = await begin();
    const res = await postEvent({ type: "client.opted_out", client: { id: c.ev.id } });
    assert.equal(res.status, 200);
    assert.equal(await optedOut(c.phone), true);

    assert.equal(await promote(`checkin-${c.id}-${c.localDate}`), true);
    await sleep(800);
    assert.equal((await sentTo(c.phone)).length, 1, "no question sent");
  });

  test("a later website opt-in does not undo it; only texting START does", async () => {
    const c = await begin();
    await postEvent({ type: "client.opted_out", client: { id: c.ev.id } });
    await postEvent({ type: "client.opted_in", client: c.ev });
    assert.equal(await optedOut(c.phone), true);
    await inbound(c.phone, "START");
    await waitFor(async () => !(await optedOut(c.phone)), "opted back in");
  });

  test("an unknown client id is accepted and changes nothing", async () => {
    assert.equal((await postEvent({ type: "client.opted_out", client: { id: randomUUID() } })).status, 200);
  });
});
