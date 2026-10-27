import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** An error from Twilio, with a verdict on whether trying again could help. */
export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

/** Twilio's "this number replied STOP" error. We must never text them again. */
export const TWILIO_UNSUBSCRIBED = 21610;

/**
 * Sends one SMS through Twilio's REST API. No SDK: it is a single form POST, and keeping it in
 * one small function makes the retry rules below easy to read and to test against a fake server.
 */
export async function sendSms(input: { to: string; body: string }): Promise<{ sid: string; status: string }> {
  const c = config();
  const url = `${c.TWILIO_API_BASE}/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    To: input.to,
    From: c.TWILIO_FROM_NUMBER,
    Body: input.body,
    StatusCallback: `${c.PUBLIC_BASE_URL}/webhooks/twilio/status`,
  });
  const auth = Buffer.from(`${c.TWILIO_ACCOUNT_SID}:${c.TWILIO_AUTH_TOKEN}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Network failure or timeout: Twilio may or may not have the request, so retrying is right.
    throw new TwilioError(`Network error talking to Twilio: ${(err as Error).message}`, 0, null, true);
  }

  const data = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
  if (res.ok && data.sid) return { sid: data.sid, status: data.status ?? "queued" };

  // 5xx and 429 are Twilio's problem or a rate limit; anything else (bad number, bad auth) won't fix itself.
  const retryable = res.status >= 500 || res.status === 429;
  throw new TwilioError(data.message ?? `Twilio returned ${res.status}`, res.status, data.code ?? null, retryable);
}

/**
 * Twilio signs every webhook: base64(HMAC-SHA1(authToken, fullUrl + each POST param name and value,
 * sorted by name)). Without checking it, anyone could post fake "DONE" replies to our endpoint.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
