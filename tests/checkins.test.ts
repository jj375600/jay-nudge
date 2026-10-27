import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { closeDb, query } from "../src/db.js";
import { closeQueues } from "../src/queues.js";
import { addDays, localDateString, nextLocalOccurrence } from "../src/time.js";
import { checkinFor, inbound, jobExists, optIn, promote, sentTo, sleep, waitFor, waitForTexts } from "./helpers.js";

after(async () => {
  await closeQueues();
  await closeDb();
});

/** A fresh opted-in client whose welcome text has already gone out. */
async function begin() {
  const c = await optIn();
  await waitForTexts(c.phone, 1);
  const id = c.contact!.id;
  const localDate = localDateString(nextLocalOccurrence(new Date(), c.timezone, config().CHECKIN_HOUR), c.timezone);
  return { ...c, id, localDate };
}
type Client = Awaited<ReturnType<typeof begin>>;

/** Fast-forward to the daily check-in and wait for the question to land. */
async function ask(c: Client) {
  assert.equal(await promote(`checkin-${c.id}-${c.localDate}`), true, "the check-in job was scheduled");
  await waitForTexts(c.phone, 2);
  return waitFor(() => checkinFor(c.id), "check-in row");
}

/** Say something and wait for the bot's `n`-th text overall. */
async function say(c: Client, text: string, expectTexts: number) {
  const { res } = await inbound(c.phone, text);
  assert.equal(res.status, 200);
  const texts = await waitForTexts(c.phone, expectTexts);
  return texts[expectTexts - 1]!.body;
}

describe("the daily check-in", () => {
  test("asks the question, lines up the nudges and the end-of-day close, and schedules tomorrow's check-in", async () => {
    const c = await begin();
    const row = await ask(c);
    assert.equal(row.status, "pending");

    const [, question] = await sentTo(c.phone);
    assert.match(question!.body, /Hi Maya! Did you get your workout in today\?/);
    assert.match(question!.body, /DONE/);

    assert.equal(await jobExists(`nag-${row.id}-1`), true);
    assert.equal(await jobExists(`nag-${row.id}-2`), true);
    assert.equal(await jobExists(`close-${row.id}`), true);
    assert.equal(await jobExists(`checkin-${c.id}-${addDays(c.localDate, 1)}`), true, "tomorrow is already scheduled");
  });

  test("replying DONE logs it, and the nudges that were queued then do nothing", async () => {
    const c = await begin();
    const row = await ask(c);

    assert.equal(await say(c, "done!", 3), "Logged. Nice work, Maya! Streak: 1 day.");
    assert.equal((await checkinFor(c.id))!.status, "completed");

    assert.equal(await promote(`nag-${row.id}-1`), true);
    await sleep(700);
    assert.equal((await sentTo(c.phone)).length, 3, "no nudge after a reply");
    assert.equal((await checkinFor(c.id))!.nags_sent, 0);
  });

  test("with no reply: two nudges, then the day closes as missed and the streak is zero", async () => {
    const c = await begin();
    const row = await ask(c);

    await promote(`nag-${row.id}-1`);
    let texts = await waitForTexts(c.phone, 3);
    assert.match(texts[2]!.body, /Quick nudge, Maya/);

    await promote(`nag-${row.id}-2`);
    texts = await waitForTexts(c.phone, 4);
    assert.match(texts[3]!.body, /Last call for today, Maya/);
    assert.equal((await checkinFor(c.id))!.nags_sent, 2);

    await promote(`close-${row.id}`);
    await waitFor(async () => (await checkinFor(c.id))!.status === "missed", "day closed as missed");

    assert.equal(await say(c, "streak", 5), "Streak: 0 days. Best: 0 days. Last 7 days: 0 workouts.");
  });

  test("SKIP is a rest day: logged, not counted, and the streak is safe", async () => {
    const c = await begin();
    await ask(c);
    // two earlier completed days build a streak of 2
    for (const back of [1, 2]) await query("INSERT INTO checkins (contact_id, local_date, status) VALUES ($1, $2, 'completed')", [c.id, addDays(c.localDate, -back)]);

    assert.equal(await say(c, "skip", 3), "Rest day logged. Your streak is safe at 2 days.");
    assert.equal((await checkinFor(c.id))!.status, "skipped");
  });

  test("NO is an honest miss", async () => {
    const c = await begin();
    await ask(c);
    assert.equal(await say(c, "no", 3), "Logged. Tomorrow is a fresh start.");
    assert.equal((await checkinFor(c.id))!.status, "missed");
  });

  test("the streak counts earlier days: three in a row plus today is four", async () => {
    const c = await begin();
    await ask(c);
    for (const back of [1, 2, 3]) await query("INSERT INTO checkins (contact_id, local_date, status) VALUES ($1, $2, 'completed')", [c.id, addDays(c.localDate, -back)]);
    assert.equal(await say(c, "DONE", 3), "Logged. Nice work, Maya! Streak: 4 days.");
    assert.equal(await say(c, "streak", 4), "Streak: 4 days. Best: 4 days. Last 7 days: 4 workouts.");
  });

  test("DONE twice, or a later NO after DONE, doesn't change a logged workout", async () => {
    const c = await begin();
    await ask(c);
    await say(c, "done", 3);
    assert.equal(await say(c, "done", 4), "Already logged today. Streak: 1 day.");
    assert.equal(await say(c, "no", 5), "You already logged a workout today. Streak: 1 day.");
    assert.equal((await checkinFor(c.id))!.status, "completed");
  });

  test("texting DONE before the check-in is due logs it, and the check-in then doesn't ask", async () => {
    const c = await begin();
    assert.equal(await say(c, "done", 2), "Logged. Nice work, Maya! Streak: 1 day.");

    assert.equal(await promote(`checkin-${c.id}-${c.localDate}`), true);
    await waitFor(async () => jobExists(`checkin-${c.id}-${addDays(c.localDate, 1)}`), "tomorrow scheduled even so");
    await sleep(500);
    assert.equal((await sentTo(c.phone)).length, 2, "no question after they already logged");
  });

  test("an opted-in client who answers 'yes' to the check-in is logged as done", async () => {
    const c = await begin();
    await ask(c);
    assert.equal(await say(c, "Yes", 3), "Logged. Nice work, Maya! Streak: 1 day.");
  });
});

describe("other commands", () => {
  test("a webhook Twilio retries is processed once: one reply, one record", async () => {
    const c = await begin();
    await ask(c);
    const first = await inbound(c.phone, "done", "SMretry000000000000000000000001" + String(c.id).padStart(2, "0"));
    const second = await inbound(c.phone, "done", first.sid);
    assert.equal(first.res.status, 200);
    assert.equal(second.res.status, 200);
    await waitForTexts(c.phone, 3);
    await sleep(500);
    assert.equal((await sentTo(c.phone)).length, 3);
    const rows = await query("SELECT 1 FROM messages WHERE twilio_sid = $1", [first.sid]);
    assert.equal(rows.length, 1);
  });

  test("HELP lists the commands", async () => {
    const c = await begin();
    assert.match(await say(c, "help", 2), /DONE.*SKIP.*NO.*STREAK.*STOP/);
  });

  test("a message it can't understand gets one polite reply an hour, so two bots can't loop", async () => {
    const c = await begin();
    assert.match(await say(c, "what is the meaning of life", 2), /Sorry, I didn't get that/);
    await inbound(c.phone, "asdf qwerty");
    await inbound(c.phone, "zzz");
    await sleep(700);
    assert.equal((await sentTo(c.phone)).length, 2, "still just the welcome and one 'didn't get that'");
  });
});
