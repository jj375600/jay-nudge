import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, query } from "../src/db.js";
import { enqueueSms } from "../src/outbound.js";
import { closeQueues } from "../src/queues.js";
import { callsTo, contactByPhone, failNext, inbound, optIn, sentTo, sleep, waitFor, waitForTexts } from "./helpers.js";

after(async () => {
  await closeQueues();
  await closeDb();
});

async function begin() {
  const c = await optIn();
  await waitForTexts(c.phone, 1); // the welcome is out of the way
  return { ...c, id: c.contact!.id };
}

async function send(c: { id: number }, body = "Test message", dedupeKey = randomUUID()) {
  await enqueueSms({ contactId: c.id, kind: "reply", body, dedupeKey });
  return dedupeKey;
}
const messageStatus = async (key: string) => (await query<{ status: string; error: string | null }>("SELECT status, error FROM messages WHERE dedupe_key = $1", [key]))[0];
const outcomes = async (phone: string) => (await callsTo(phone)).map((c) => c.outcome).slice(1); // skip the welcome

describe("when Twilio has a bad moment", () => {
  test("a server error is retried with backoff and the text still goes out, once", async () => {
    const c = await begin();
    await failNext(c.phone, { status: 503, times: 2 });
    const key = await send(c);
    await waitFor(async () => (await messageStatus(key))?.status === "sent", "message sent after retries");
    assert.deepEqual(await outcomes(c.phone), ["failed:503", "failed:503", "sent"]);
    assert.equal((await sentTo(c.phone)).length, 2, "the welcome plus exactly one copy of this text");
  });

  test("a rate-limit response (429) is also retried", async () => {
    const c = await begin();
    await failNext(c.phone, { status: 429, times: 1 });
    const key = await send(c);
    await waitFor(async () => (await messageStatus(key))?.status === "sent", "message sent after a 429");
    assert.deepEqual(await outcomes(c.phone), ["failed:429", "sent"]);
  });

  test("it gives up after the configured number of attempts and records the failure", async () => {
    const c = await begin();
    await failNext(c.phone, { status: 500, times: 50, message: "Twilio is down" });
    const key = await send(c);
    await waitFor(async () => (await messageStatus(key))?.status === "failed", "message marked failed");
    await sleep(600);
    assert.deepEqual(await outcomes(c.phone), ["failed:500", "failed:500", "failed:500"], "three attempts, no more");
    assert.match((await messageStatus(key))!.error ?? "", /Twilio is down/);
  });
});

describe("errors that won't fix themselves", () => {
  test("an invalid number is not retried", async () => {
    const c = await begin();
    await failNext(c.phone, { status: 400, code: 21211, times: 50, message: "The 'To' number is not a valid phone number" });
    const key = await send(c);
    await waitFor(async () => (await messageStatus(key))?.status === "failed", "message marked failed");
    await sleep(600); // long enough for any retry (100ms backoff) to have shown up
    assert.deepEqual(await outcomes(c.phone), ["failed:400"]);
  });

  test("Twilio saying the person unsubscribed (21610) opts them out here too", async () => {
    const c = await begin();
    await failNext(c.phone, { status: 400, code: 21610, times: 50, message: "unsubscribed recipient" });
    const key = await send(c);
    await waitFor(async () => (await messageStatus(key))?.status === "failed", "message marked failed");
    assert.equal((await contactByPhone(c.phone))!.opted_out, true);
    assert.deepEqual(await outcomes(c.phone), ["failed:400"]);
  });
});

describe("sending exactly once", () => {
  test("asking to send the same thing twice sends it once", async () => {
    const c = await begin();
    const key = randomUUID();
    await send(c, "Only once please", key);
    await send(c, "Only once please", key);
    await waitFor(async () => (await messageStatus(key))?.status === "sent", "sent");
    await sleep(500);
    assert.equal((await sentTo(c.phone)).filter((t) => t.body === "Only once please").length, 1);
  });

  test("a message to someone who has opted out is never sent", async () => {
    const c = await begin();
    await inbound(c.phone, "stop");
    await waitFor(async () => (await contactByPhone(c.phone))!.opted_out, "opted out");
    const key = await send(c);
    await sleep(700);
    assert.equal((await sentTo(c.phone)).length, 1, "just the welcome");
    assert.equal(await messageStatus(key), undefined, "not even recorded as sent");
  });
});
