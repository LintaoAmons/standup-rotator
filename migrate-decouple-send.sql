-- One-time migration for the send/rotation decouple (owner ask, 8th round, 2026-08-18).
--
-- The send gate changed from once-per-DAY (keyed on announced_date) to once-per
-- (date, configured-time) SLOT (keyed on last_sent_slot), so editing the announce
-- time re-arms the send the same day. This retires the old announced_date column
-- and adds last_sent_slot. Run this ONCE against the remote DB, AFTER
-- migrate-announce-time.sql has already added announced_date:
--
--   npx wrangler d1 execute DB --remote --file=migrate-decouple-send.sql
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS`, so this is
-- NOT idempotent: re-running errors ("duplicate column name" / "no such column")
-- — harmless, it means the migration already ran. Run it exactly once.
--
-- The UPDATE carries the old stamp forward so a MID-DAY deploy does not double-post:
-- if today was already announced under the old date-only key, seed today's CURRENT
-- slot as already-sent (announced_date is a date; append the live announce_time to
-- form the slot). Effect:
--   * announced_date == today  -> last_sent_slot = "today|HH:MM" -> today's send is
--                                 suppressed for the current time, but changing the
--                                 time still re-arms (the new behaviour).
--   * announced_date is older   -> "olddate|HH:MM" != today's slot -> today fires
--                                 normally at the configured time (correct).
ALTER TABLE settings ADD COLUMN last_sent_slot TEXT NOT NULL DEFAULT '';
UPDATE settings SET last_sent_slot = announced_date || '|' || announce_time
  WHERE announced_date <> '';
ALTER TABLE settings DROP COLUMN announced_date;
