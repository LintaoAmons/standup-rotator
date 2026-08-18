-- One-time migration for the Sent history feature (owner ask, 7th round, 2026-08-18).
--
-- Non-destructive: adds ONE brand-new table (and its index) and touches nothing
-- existing. schema.sql already declares send_log for FRESH databases, but the prod
-- DB predates it, so run this once against the remote DB:
--
--   npx wrangler d1 execute DB --remote --file=migrate-send-log.sql
--
-- Because this only creates a NEW table with CREATE TABLE IF NOT EXISTS (unlike
-- migrate-announce-time.sql, which ALTERs an existing table and is single-shot),
-- it is fully idempotent — safe to re-run with no error.
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
