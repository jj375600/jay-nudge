# Security notes

jay-nudge texts real phone numbers, so it is built to be strict about who may talk to it and who it may talk to.
It is still a portfolio project; the limitations at the bottom are stated plainly.

## What it defends against

| Threat | Defence | Where it's tested |
| --- | --- | --- |
| Someone posts fake replies (a forged "STOP", "DONE") to the Twilio webhook | Every Twilio webhook must carry a valid `X-Twilio-Signature` (HMAC-SHA1 over the exact public URL plus the sorted form fields, compared in constant time). Wrong token, edited body or a different URL is a `403` and has no side effects. The code is checked against the worked example in Twilio's own documentation | `tests/signatures.test.ts`, `tests/webhooks.test.ts` |
| Someone posts fake booking events | Events from JAY-AESTHETIX are signed like Stripe webhooks: `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. Wrong secret or edited body is a `401` | `tests/signatures.test.ts`, `tests/events.test.ts` |
| Replay of a captured, valid event | The timestamp is inside the signed text and must be within 5 minutes, so it cannot be edited to look fresh | `tests/signatures.test.ts` |
| A sender or Twilio retries a delivery | Events are recorded by id (`events_seen`) and Twilio messages by `MessageSid`, so a retry is processed once | `tests/events.test.ts`, `tests/checkins.test.ts` |
| Texting someone twice, or after they said STOP | Every text has a unique `dedupe_key`; opt-out is checked again at send time, so a job queued before STOP still sends nothing. STOP is honoured anywhere in a message | `tests/delivery.test.ts`, `tests/optout.test.ts` |
| Two bots answering each other forever | At most one "didn't understand" reply per contact per hour | `tests/checkins.test.ts` |
| Leaking phone numbers | Logs and the admin summary show only the last four digits. The admin endpoint needs a bearer token (constant-time compare) | `tests/admin.test.ts` |
| Dashboard attacks (script injection, token leaks) | `/admin` is a static page with no data in it. Data comes from `/admin/summary` with the bearer token in a header, never in a URL. A Content-Security-Policy allows only that one script (by hash), the page writes server text with `textContent`, never `innerHTML`, and the page can't be framed | `tests/admin.test.ts` |
| A failing provider causing duplicate or lost texts | Transient errors (5xx, 429, network) are retried with exponential backoff, permanent ones (bad number) are not, and the attempt is recorded either way | `tests/delivery.test.ts` |
| Injection | All SQL is parameterised. Inbound text is only ever compared to a fixed command list, never executed or interpolated | n/a |
| Secrets in the repo | Configuration is read from the environment and validated at start-up; `.env` is git-ignored; `.env.test` holds only fake values | n/a |

## Consent and messaging rules

- A phone number only enters the system from a signed event, which JAY-AESTHETIX sends only after the client ticks an
  explicit SMS-consent checkbox.
- The first text identifies the sender and says how to stop (`STOP`) and get help (`HELP`).
- Quiet hours (default 21:00 to 08:00 in the client's time zone) hold back nudges. Nudges never run past local midnight.
- Replying `START` or `YES` after `STOP` is the only way back in. A website event cannot override an opt-out.

## Known limitations (deliberately out of scope for a portfolio project)

- **US carrier registration.** Texting US numbers from your own number requires registering a brand and campaign (A2P 10DLC)
  with Twilio, which is a paid, multi-day process. A trial account can only text numbers you have verified. This project
  has been tested against a fake Twilio server, and the Twilio module is small and isolated so it can be pointed at the
  real service.
- **Not legal advice.** The consent and opt-out handling follows common practice, but a real deployment should be reviewed
  against the TCPA and carrier rules for its use case.
- No rate limiting on the public endpoints beyond signature checks (put it behind a CDN or proxy in production).
- Message bodies are stored for audit. A real deployment would add a retention period.
- The dashboard is read-only and uses one shared token, not user accounts. The token is kept in the browser tab's session storage until the tab closes.
