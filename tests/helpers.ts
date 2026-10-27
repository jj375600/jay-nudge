// Shared test plumbing. The tests are black-box: they talk to the running server over HTTP,
// read the real Postgres and Redis, and watch a fake Twilio server record every text "sent".
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { query } from "../src/db.js";
import { signEvent } from "../src/events.js";
import { getQueues } from "../src/queues.js";
import { localParts } from "../src/time.js";
import { twilioSignature } from "../src/twilio.js";

export const BASE = process.env.BASE_URL ?? "http://localhost:4000";
export const FAKE = process.env.FAKE_TWILIO_BASE ?? "http://localhost:4020";

let counter = Math.floor(Math.random() * 1_000_000);
/** A unique fake number per call, so test files running in parallel never see each other's texts. */
export function uniquePhone(): string {
  counter += 1;
  return `+1555${String(counter % 10_000_000).padStart(7, "0")}`;
}

/** The first of these zones where it is currently mid-morning to early afternoon, so "today" is safe to test in. */
export function middayTimezone(): string {
  const zones = [
    "Pacific/Honolulu", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
    "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata",
    "Asia/Bangkok", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
  ];
  const now = new Date();
  return zones.find((z) => { const h = localParts(now, z).hour; return h >= 9 && h <= 14; }) ?? "Asia/Kolkata";
}

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, what: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fake Twilio

export type Call = { sid?: string; to: string; from?: string; body: string; outcome: string; statusCallback?: string };

export async function callsTo(phone: string): Promise<Call[]> {
  const res = await fetch(`${FAKE}/__calls?to=${encodeURIComponent(phone)}`);
  return (await res.json()) as Call[];
}

export async function sentTo(phone: string): Promise<Call[]> {
  return (await callsTo(phone)).filter((c) => c.outcome === "sent");
}

export async function waitForTexts(phone: string, n: number, timeoutMs = 10_000): Promise<Call[]> {
  return waitFor(async () => {
    const s = await sentTo(phone);
    return s.length >= n ? s : false;
  }, `${n} text(s) to ${phone}`, timeoutMs);
}

export async function failNext(to: string, opts: { status?: number; code?: number | null; times?: number; message?: string }): Promise<void> {
  await fetch(`${FAKE}/__fail`, { method: "POST", body: JSON.stringify({ to, ...opts }) });
}

// ---------------------------------------------------------------- events

export function client(overrides: Partial<{ id: string; name: string; phone: string; timezone: string }> = {}) {
  return { id: `c-${randomUUID()}`, name: "Maya Johnson", phone: uniquePhone(), timezone: middayTimezone(), ...overrides };
}

export async function postRaw(raw: string, signature?: string): Promise<Response> {
  return fetch(`${BASE}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-nudge-signature": signature } : {}) },
    body: raw,
  });
}

export async function postEvent(event: object): Promise<Response> {
  const raw = JSON.stringify({ eventId: randomUUID(), ...event });
  return postRaw(raw, signEvent(config().EVENTS_SECRET, raw));
}

export async function optIn(c = client()) {
  const res = await postEvent({ type: "client.opted_in", client: c });
  if (res.status !== 200) throw new Error(`opt-in failed: ${res.status} ${await res.text()}`);
  return { ...c, contact: await contactByPhone(c.phone) };
}

export async function contactByPhone(phone: string) {
  const [row] = await query<{ id: number; name: string; timezone: string; opted_out: boolean }>(
    "SELECT id, name, timezone, opted_out FROM contacts WHERE phone = $1", [phone],
  );
  return row;
}

// ---------------------------------------------------------------- Twilio webhooks

export async function inbound(phone: string, body: string, sid: string = `SM${randomUUID().replace(/-/g, "")}`) {
  const params = { From: phone, To: config().TWILIO_FROM_NUMBER, Body: body, MessageSid: sid };
  const url = "/webhooks/twilio/inbound";
  const sig = twilioSignature(config().TWILIO_AUTH_TOKEN, config().PUBLIC_BASE_URL + url, params);
  const res = await fetch(BASE + url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    body: new URLSearchParams(params),
  });
  return { res, sid };
}

// ---------------------------------------------------------------- queue

/** Fast-forward a delayed job, as if its time had arrived. Returns false if the job doesn't exist. */
export async function promote(jobId: string): Promise<boolean> {
  const job = await getQueues().schedule.getJob(jobId);
  if (!job) return false;
  await job.promote();
  return true;
}

export async function jobExists(jobId: string): Promise<boolean> {
  return Boolean(await getQueues().schedule.getJob(jobId));
}

export async function checkinFor(contactId: number) {
  const [row] = await query<{ id: number; status: string; nags_sent: number; local_date: string }>(
    "SELECT id, status, nags_sent, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM checkins WHERE contact_id = $1 ORDER BY local_date DESC LIMIT 1",
    [contactId],
  );
  return row;
}
