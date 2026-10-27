import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { closeDb } from "../src/db.js";
import { closeQueues } from "../src/queues.js";
import { BASE, optIn, waitForTexts } from "./helpers.js";

after(async () => {
  await closeQueues();
  await closeDb();
});

describe("health and admin", () => {
  test("/health reports the database and Redis are reachable", async () => {
    const res = await fetch(`${BASE}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test("the admin summary needs the right bearer token", async () => {
    assert.equal((await fetch(`${BASE}/admin/summary`)).status, 401);
    assert.equal((await fetch(`${BASE}/admin/summary`, { headers: { authorization: "Bearer wrong_token_0000000000000000" } })).status, 401);
    assert.equal((await fetch(`${BASE}/admin/summary`, { headers: { authorization: config().ADMIN_TOKEN } })).status, 401, "must be a Bearer token");
    assert.equal((await fetch(`${BASE}/admin/summary`, { headers: { authorization: `Bearer ${config().ADMIN_TOKEN}` } })).status, 200);
  });

  test("the summary shows activity but never a full phone number", async () => {
    const c = await optIn();
    await waitForTexts(c.phone, 1);
    const res = await fetch(`${BASE}/admin/summary`, { headers: { authorization: `Bearer ${config().ADMIN_TOKEN}` } });
    const text = await res.text();
    const body = JSON.parse(text);
    assert.ok(body.contacts.total >= 1);
    assert.ok(body.recent.length > 0);
    assert.ok(!text.includes(c.phone), "full number must not appear");
    assert.ok(body.recent.every((m: { phone: string | null }) => m.phone === null || /^\*+\d{4}$/.test(m.phone)));
  });

  test("an unknown route is a 404, not a crash", async () => {
    assert.equal((await fetch(`${BASE}/nope`)).status, 404);
  });
});
