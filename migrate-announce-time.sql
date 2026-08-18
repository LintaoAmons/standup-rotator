-- One-time migration for the configurable announcement time (owner ask, 2026-08-18).
--
-- schema.sql already declares these columns for FRESH databases, but an existing
-- prod DB has the settings table, so `CREATE TABLE IF NOT EXISTS` skips it and the
-- two new columns are missing. Run this ONCE against the remote DB:
--
--   npx wrangler d1 execute DB --remote --file=migrate-announce-time.sql
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so this is NOT idempotent: running it a
-- second time errors with "duplicate column name" (harmless — it means the columns
-- are already there). Run it exactly once.
ALTER TABLE settings ADD COLUMN announce_time  TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE settings ADD COLUMN announced_date TEXT NOT NULL DEFAULT '';
