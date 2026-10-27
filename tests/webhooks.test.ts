import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { closeDb, query } from "../src/db.js";
import { closeQueues } from "../src/queues.js";
import { twilioSignature } from "../src/twilio.js";
import { BASE, client, contactByPhone, inbound, optIn, sentTo, sleep, uniquePhone, waitFor, waitForTexts } from "./helpers.js";

after(async () => {
  await closeQueues();
  await closeDb();
});

async function post(path: string, params: Record<string, string>, opts: { signWith?: Record<string, string>; token?: string; url?: string; omit?: boolean } = {}) {
  const url = opts.url ?? config().PUBLIC_BASE_URL + path;
  const sig = twilioSignature(opts.token ?? config().TWILIO_AUTH_TOKEN, url, opts.signWith ?? params);
  return fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(opts.omit ? {} : { "x-twilio-signature": sig }) },
    body: new URLSearchParams(params),
  });
}

describe("inbound text webhook", () => {
  const params = () => ({ From: uniquePhone(), To: config().TWILIO_FROM_NUMBER, Body: "done", MessageSid: `SM${randomUUID().replace(/-/g, "")}` });

  test("only genuine Twilio requests are accepted", async () => {
    const p = params();
    const path = "/webhooks/twilio/inbound";
    assert.equal((await post(path, p, { omit: true })).status, 403, "no signature");
    assert.equal((await post(path, p, { token: "not_the_auth_token_00000000000000" })).status, 403, "signed with the wrong token");
    assert.equal((await post(path, { ...p, Body: "stop" }, { signWith: p })).status, 403, "body changed after signing");
    assert.equal((await post(path, p, { url: "https://evil.example.com" + path })).status, 403, "signed for a different URL");
    assert.equal((await post(path, p)).status, 200, "the genuine one passes");
  });

  test("the reply is an empty TwiML document", async () => {
    const res = await post("/webhooks/twilio/inbound", params());
    assert.match(res.headers.get("content-type") ?? "", /text\/xml/);
    assert.equal(await res.text(), "<Response></Response>");
  });

  test("a forged request creates no side effects", async () => {
    const c = await optIn();
    await waitForTexts(c.phone, 1);
    const p = { From: c.phone, To: config().TWILIO_FROM_NUMBER, Body: "stop", MessageSid: `SM${randomUUID().replace(/-/g, "")}` };
    assert.equal((await post("/webhooks/twilio/inbound", p, { omit: true })).status, 403);
    await sleep(300);
    assert.equal((await contactByPhone(c.phone))!.opted_out, false, "a fake STOP must not opt anyone out");
    const logged = await query("SELECT 1 FROM messages WHERE twilio_sid = $1", [p.MessageSid]);
    assert.equal(logged.length, 0);
  });

  test("a text from a number we don't know is logged and ignored, with no reply", async () => {
    const stranger = uniquePhone();
    const { res, sid } = await inbound(stranger, "hello?");
    assert.equal(res.status, 200);
    await sleep(500);
    assert.equal((await sentTo(stranger)).length, 0, "never reply to strangers");
    const [row] = await query<{ contact_id: number | null }>("SELECT contact_id FROM messages WHERE twilio_sid = $1", [sid]);
    assert.equal(row?.contact_id, null);
  });

  test("a request missing its required fields is a 400 (after the signature check)", async () => {
    const res = await post("/webhooks/twilio/inbound", { Body: "hi" });
    assert.equal(res.status, 400);
  });
});

describe("delivery status webhook", () => {
  async function sentMessage() {
    const c = await optIn();
    const [welcome] = await waitForTexts(c.phone, 1);
    const [row] = await waitFor(async () => {
      const r = await query<{ id: number; status: string }>("SELECT id, status FROM messages WHERE twilio_sid = $1", [welcome!.sid]);
      return r.length ? r : false;
    }, "message row");
    return { sid: welcome!.sid!, id: row!.id };
  }
  const status = async (id: number) => (await query<{ status: string; error: string | null }>("SELECT status, error FROM messages WHERE id = $1", [id]))[0]!;
  const path = "/webhooks/twilio/status";

  test("records delivered, and a later 'sent' callback can't move it backwards", async () => {
    const m = await sentMessage();
    assert.equal((await status(m.id)).status, "sent");

    assert.equal((await post(path, { MessageSid: m.sid, MessageStatus: "delivered" })).status, 200);
    assert.equal((await status(m.id)).status, "delivered");

    await post(path, { MessageSid: m.sid, MessageStatus: "sent" }); // callbacks can arrive out of order
    assert.equal((await status(m.id)).status, "delivered");
  });

  test("records undelivered and failed with Twilio's error code", async () => {
    const m = await sentMessage();
    await post(path, { MessageSid: m.sid, MessageStatus: "undelivered", ErrorCode: "30003" });
    const s = await status(m.id);
    assert.equal(s.status, "undelivered");
    assert.match(s.error ?? "", /30003/);
  });

  test("an unsigned status callback is refused and changes nothing", async () => {
    const m = await sentMessage();
    assert.equal((await post(path, { MessageSid: m.sid, MessageStatus: "delivered" }, { omit: true })).status, 403);
    assert.equal((await status(m.id)).status, "sent");
  });
});
