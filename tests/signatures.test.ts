import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { signEvent, verifyEventSignature } from "../src/events.js";
import { twilioSignature, verifyTwilioSignature } from "../src/twilio.js";

describe("Twilio webhook signature", () => {
  // The worked example from Twilio's own documentation, so this checks us against Twilio, not against ourselves.
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" };

  test("matches Twilio's published example", () => {
    assert.equal(twilioSignature("12345", url, params), "GvWf1cFY/Q7PnoempGyD5oXAezc=");
  });

  test("rejects a wrong token, a changed parameter, a changed URL and a missing header", () => {
    const good = twilioSignature("12345", url, params);
    assert.equal(verifyTwilioSignature("12345", url, params, good), true);
    assert.equal(verifyTwilioSignature("other", url, params, good), false);
    assert.equal(verifyTwilioSignature("12345", url, { ...params, Digits: "9999" }, good), false);
    assert.equal(verifyTwilioSignature("12345", url + "&x=1", params, good), false);
    assert.equal(verifyTwilioSignature("12345", url, params, undefined), false);
    assert.equal(verifyTwilioSignature("12345", url, params, "short"), false);
  });
});

describe("JAY-AESTHETIX event signature", () => {
  const secret = "a_long_shared_secret_value_1234";
  const body = JSON.stringify({ eventId: "e1", type: "session.cancelled", session: { id: "9" } });
  const now = 1_800_000_000;

  test("accepts a fresh, correctly signed body", () => {
    assert.equal(verifyEventSignature(secret, body, signEvent(secret, body, now), now), "ok");
  });

  test("rejects a changed body, a wrong secret and garbage", () => {
    const header = signEvent(secret, body, now);
    assert.equal(verifyEventSignature(secret, body.replace("9", "8"), header, now), "invalid");
    assert.equal(verifyEventSignature("different_secret_value_12345", body, header, now), "invalid");
    assert.equal(verifyEventSignature(secret, body, undefined, now), "invalid");
    assert.equal(verifyEventSignature(secret, body, "nonsense", now), "invalid");
    assert.equal(verifyEventSignature(secret, body, `t=${now}`, now), "invalid");
  });

  test("rejects an old but otherwise valid signature (replay), within a 5 minute window", () => {
    const header = signEvent(secret, body, now);
    assert.equal(verifyEventSignature(secret, body, header, now + 299), "ok");
    assert.equal(verifyEventSignature(secret, body, header, now + 301), "stale");
    assert.equal(verifyEventSignature(secret, body, header, now - 301), "stale");
  });

  test("the timestamp is covered by the signature, so it can't be edited to look fresh", () => {
    const old = signEvent(secret, body, now - 10_000);
    const v1 = old.split("v1=")[1];
    assert.equal(verifyEventSignature(secret, body, `t=${now},v1=${v1}`, now), "invalid");
  });
});
