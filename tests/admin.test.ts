import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { closeDb } from "../src/db.js";
import { closeQueues } from "../src/queues.js";
import { createHash } from "node:crypto";
import { BASE, client, optIn, waitForTexts } from "./helpers.js";

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

  test("the summary lists clients by first name and masked number, with their last 14 days", async () => {
    const c = await optIn({ ...client(), name: "Zelda Fitzgerald" });
    await waitForTexts(c.phone, 1);
    const res = await fetch(`${BASE}/admin/summary`, { headers: { authorization: `Bearer ${config().ADMIN_TOKEN}` } });
    const text = await res.text();
    assert.ok(!text.includes("Fitzgerald"), "last names never leave the server");
    assert.ok(!text.includes(c.phone));
    const mine = JSON.parse(text).clients.find((x: { name: string; phone: string }) => x.name === "Zelda" && x.phone.endsWith(c.phone.slice(-4)));
    assert.ok(mine, "the new client is listed");
    assert.equal(mine.days.length, 14);
    assert.ok(mine.days.every((d: string) => ["completed", "skipped", "missed", "pending", "none"].includes(d)));
    assert.equal(mine.optedOut, false);
    assert.equal(typeof mine.current, "number");
  });

  test("the dashboard page holds no data and sets a strict Content-Security-Policy", async () => {
    const c = await optIn();
    await waitForTexts(c.phone, 1);
    const res = await fetch(`${BASE}/admin`);
    assert.equal(res.status, 200, "the page itself needs no token: it contains nothing private");
    const html = await res.text();
    assert.ok(!html.includes(c.phone) && !html.includes(c.phone.slice(-4)), "no client data in the page");
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "inline scripts are allowed only by hash");
    // The one script on the page must be exactly the one the policy names.
    const script = /<script>([\s\S]*?)<\/script>/i.exec(html)![1]!;
    const hash = createHash("sha256").update(script).digest("base64");
    assert.ok(csp.includes(`'sha256-${hash}'`), "the policy's hash matches the page's script");
    assert.ok(!/innerHTML|outerHTML|document\.write|eval\(/.test(script), "server text is only ever written with textContent");
  });

  test("an unknown route is a 404, not a crash", async () => {
    assert.equal((await fetch(`${BASE}/nope`)).status, 404);
  });
});
