-- D1 schema for standup-rotator. Three tables mirroring the domain shapes.
-- Idempotent: safe to run repeatedly (local dev, migrations).

-- roster: the rotation, in order. `position` carries the order — the order IS
-- the rotation order, so it must be stored, not inferred from insertion.
CREATE TABLE IF NOT EXISTS roster (
  id       TEXT    PRIMARY KEY,
  name     TEXT    NOT NULL,
  handle   TEXT    NOT NULL DEFAULT '',   -- notification-channel address; may be blank
  position INTEGER NOT NULL               -- rotation order, ascending
);

-- leave: closed date intervals [from_date, to_date], inclusive. A member may
-- have several rows. Dates are YYYY-MM-DD text so string compare == date compare.
CREATE TABLE IF NOT EXISTS leave (
  member_id TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leave_member ON leave (member_id);

-- history: one authoritative pick per day. `date` is the PRIMARY KEY (UNIQUE),
-- which is the idempotency mechanism: a same-day re-trigger cannot insert a
-- second row, and a --skip reroll upserts (ON CONFLICT) rather than appending.
CREATE TABLE IF NOT EXISTS history (
  date      TEXT PRIMARY KEY,   -- YYYY-MM-DD, UNIQUE
  member_id TEXT NOT NULL
);

-- settings: a singleton row (CHECK pins id to 1) holding runtime knobs the portal
-- owns, so master edits them from the logged-in page with no wrangler access:
--   google_chat_webhook — moved OUT of a Worker secret; "" == announcements off.
--   announce_time       — daily broadcast time, HH:MM in SGT (default 09:00). The
--                         cron fires every 5 min and a runtime gate (shouldAnnounce)
--                         decides the send, so this is changeable without a redeploy.
--   last_sent_slot      — the last (date, configured-time) slot the scheduled path
--                         broadcast, "YYYY-MM-DD|HH:MM"; the SEND's idempotency key
--                         (see sendSlot), kept separate from history and DECOUPLED
--                         from rotation (owner 2026-08-18). Embeds the time, so
--                         editing announce_time re-arms the send the same day.
--                         Replaces the retired date-only announced_date key.
-- NOTE: this CREATE only fires for a FRESH database. An existing prod DB already
-- has the settings table, so `CREATE TABLE IF NOT EXISTS` will NOT reconcile its
-- columns — run the migrations (migrate-announce-time.sql, then
-- migrate-decouple-send.sql) once against it (see DEPLOY.md).
CREATE TABLE IF NOT EXISTS settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  google_chat_webhook TEXT NOT NULL DEFAULT '',
  announce_time       TEXT NOT NULL DEFAULT '09:00',
  last_sent_slot      TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO settings (id, google_chat_webhook) VALUES (1, '');

-- send_log: an append-only audit of REAL Google Chat deliveries (owner ask, 7th
-- round, 2026-08-18). One row per actual webhook POST — the daily auto broadcast
-- (runScheduledTick) and the manual Announce button (POST /trigger) — recording
-- BOTH outcomes, because a FAILED send is the half the owner most wants to see. A
-- send that never happens (no webhook configured) POSTs nothing, so it writes NO
-- row: the table is signal, not noise, and never fabricates history.
--   sent_at     — UTC ISO-8601 instant. Stored UTC (unambiguous); the portal
--                 renders it in SGT (formatSgt), same fixed +8 as dayOf/minuteOf.
--   member_name — display-name SNAPSHOT at send time, so the log stays truthful
--                 after a later rename or delete (same "history never lies" rule
--                 the pick history follows — member_id alone would go dangling).
--   trigger     — 'auto' (scheduled) | 'manual' (Announce button).
--   result      — 'sent' | 'failed'; error carries a short reason when failed.
-- Unlike the settings columns this is a brand-new table, so CREATE TABLE IF NOT
-- EXISTS is fully idempotent — migrate-send-log.sql is safe to run more than once.
CREATE TABLE IF NOT EXISTS send_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at     TEXT NOT NULL,               -- UTC ISO-8601 instant
  member_id   TEXT NOT NULL,
  member_name TEXT NOT NULL,               -- display-name snapshot at send time
  trigger     TEXT NOT NULL,               -- 'auto' | 'manual'
  result      TEXT NOT NULL,               -- 'sent' | 'failed'
  error       TEXT NOT NULL DEFAULT ''     -- short reason when failed, else ''
);
CREATE INDEX IF NOT EXISTS idx_send_log_sent_at ON send_log (sent_at DESC);
