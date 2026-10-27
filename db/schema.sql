-- jay-nudge schema (PostgreSQL)

-- Everyone the bot may text. A contact only exists after the client gave SMS consent
-- (a checkbox in the JAY-AESTHETIX onboarding form), and STOP flips opted_out.
CREATE TABLE IF NOT EXISTS contacts (
  id               SERIAL PRIMARY KEY,
  external_id      TEXT UNIQUE,                     -- the client's id in JAY-AESTHETIX
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),  -- E.164
  timezone         TEXT NOT NULL DEFAULT 'America/New_York',
  opted_out        BOOLEAN NOT NULL DEFAULT FALSE,
  opted_out_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every text in either direction, for audit and idempotency.
CREATE TABLE IF NOT EXISTS messages (
  id            SERIAL PRIMARY KEY,
  contact_id    INT REFERENCES contacts(id) ON DELETE SET NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  kind          TEXT NOT NULL,                      -- welcome, reminder, checkin, nag, reply, inbound ...
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'received')),
  twilio_sid    TEXT UNIQUE,                        -- unique so a retried Twilio webhook can't double-insert
  dedupe_key    TEXT UNIQUE,                        -- unique so a retried job can't double-send
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_contact_idx ON messages (contact_id, created_at DESC);

-- One row per contact per local day: did they work out?
CREATE TABLE IF NOT EXISTS checkins (
  id            SERIAL PRIMARY KEY,
  contact_id    INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  local_date    DATE NOT NULL,                      -- the day in the contact's own timezone
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'skipped', 'missed')),
  nags_sent     INT NOT NULL DEFAULT 0,
  asked_at      TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ,
  UNIQUE (contact_id, local_date)                   -- the real guarantee against asking twice
);

-- Session reminders scheduled from JAY-AESTHETIX booking events.
CREATE TABLE IF NOT EXISTS reminders (
  id            SERIAL PRIMARY KEY,
  contact_id    INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('24h', '2h')),
  send_at       TIMESTAMPTZ NOT NULL,
  session_start TIMESTAMPTZ NOT NULL,
  focus         TEXT,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled', 'skipped')),
  UNIQUE (session_id, kind)
);

-- Every signed event we have accepted, so a retried delivery is processed once.
CREATE TABLE IF NOT EXISTS events_seen (
  event_id      TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
