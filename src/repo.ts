// Storage ports and the D1 implementation.
//
// The Repo interface is the port; runStandup depends only on it, so the use case
// is unit-testable against an in-memory fake (see test/memory-repo.ts) with no
// Worker runtime. This mirrors the Go project's domain ports — the split between
// roster (human-maintained input) and history (machine-appended output) is kept.

import type { Facilitation, Leave, Member, Roster } from "./domain";

// SendLogEntry is one REAL webhook delivery attempt — the daily auto broadcast or
// a manual Announce press — recorded for BOTH outcomes (a failed send is the half
// the owner most wants to see). Only actual POSTs land here: a send skipped for a
// missing webhook writes nothing (no noise). sentAt is a UTC ISO-8601 instant;
// memberName is the display name snapshotted at send time so the log stays
// truthful after a later rename/delete. See the send_log table in schema.sql.
export interface SendLogEntry {
  sentAt: string; // UTC ISO-8601 instant; the portal renders it in SGT (formatSgt)
  memberId: string;
  memberName: string; // snapshot at send time
  trigger: "auto" | "manual";
  result: "sent" | "failed";
  error: string; // short reason when result === "failed", else ""
}

export interface Repo {
  roster(): Promise<Roster>;
  leaves(): Promise<Leave[]>;
  // recent returns up to `limit` facilitations, newest first — a window rather
  // than a single latest record so next() can look past departed facilitators.
  recent(limit: number): Promise<Facilitation[]>;
  // on returns the facilitation recorded for a date, or null — the same-day
  // idempotency check.
  on(date: string): Promise<Facilitation | null>;
  // record commits a pick for a date. Because history.date is UNIQUE, this is an
  // upsert: the first pick of a day inserts; a --skip/--force reroll replaces
  // that day's row. The Go version appended and let "newest row wins"; UNIQUE(date)
  // collapses that to one authoritative row per day — the mandated idempotency key.
  record(f: Facilitation): Promise<void>;

  // ---- roster/leave mutation (the web CRUD surface) ----------------------
  //
  // These change human-maintained input only; they never touch history. That
  // separation is what keeps next()/idempotency intact under edits: a rename or
  // reorder cannot rewrite who already went, and deleting a member the log still
  // references is exactly the departed-facilitator case next() already handles.

  // addMember appends to the end of the rotation (position after the current
  // last), so an add never silently reshuffles the existing order. Throws if the
  // id already exists — ids are the stable identity history depends on.
  addMember(m: Member): Promise<void>;
  // deleteMember removes the roster row AND that member's leave rows (leave for a
  // non-rostered member is meaningless). History rows are left untouched: they
  // stay truthful about past picks, and next() resolves the gap by falling back
  // to the newest still-rostered facilitator.
  deleteMember(id: string): Promise<void>;
  // renameMember updates display fields only; id is immutable by design.
  renameMember(id: string, name: string, handle: string): Promise<void>;
  // setOrder rewrites positions to match the given id ordering (position = index).
  // The full-order rewrite keeps positions dense and unambiguous after any move.
  setOrder(ids: string[]): Promise<void>;

  // addLeave / deleteLeave manage closed intervals. Leave has no surrogate key,
  // so a row is identified by its (memberId, from, to) triple — the natural key.
  addLeave(l: Leave): Promise<void>;
  deleteLeave(l: Leave): Promise<void>;

  // ---- settings (portal-editable singleton) ------------------------------
  //
  // The Google Chat webhook lives in D1, not a Worker secret, so master can set
  // and rotate it from the logged-in settings page with zero wrangler access.
  // getWebhook returns "" when unset; "" == announcements off (scheduled runs
  // still pick and record silently). See the settings table in schema.sql.
  getWebhook(): Promise<string>;
  setWebhook(url: string): Promise<void>;

  // announceTime is the portal-editable daily broadcast time, HH:MM in SGT.
  // Defaults to "09:00" (schema default). The high-frequency cron reads it every
  // tick and the pure shouldAnnounce gate decides whether this tick is the one.
  getAnnounceTime(): Promise<string>;
  setAnnounceTime(hhmm: string): Promise<void>;
  // lastSentSlot is the last (date, configured-time) slot the scheduled path
  // broadcast (see sendSlot) — the idempotency key for the SEND, kept separate
  // from pick history AND decoupled from rotation (owner 2026-08-18). Embeds the
  // time so editing it re-arms the send the same day. "" until the first send.
  // Replaces the retired date-only announced_date key.
  getLastSentSlot(): Promise<string>;
  setLastSentSlot(slot: string): Promise<void>;

  // ---- send log (Sent history) -------------------------------------------
  //
  // logSend appends one real-delivery row; recentSends reads the newest `limit`
  // back (newest first) for the portal panel. Append-only: rows are never mutated
  // or deleted, so the audit stays honest.
  logSend(e: SendLogEntry): Promise<void>;
  recentSends(limit: number): Promise<SendLogEntry[]>;
}

// D1Repo implements Repo over a Cloudflare D1 database. Schema in schema.sql.
export class D1Repo implements Repo {
  constructor(private db: D1Database) {}

  async roster(): Promise<Roster> {
    // The order IS the rotation order, so it must be read back deterministically.
    const { results } = await this.db
      .prepare("SELECT id, name, handle FROM roster ORDER BY position ASC")
      .all<{ id: string; name: string; handle: string | null }>();
    return {
      members: results.map((r) => ({ id: r.id, name: r.name, handle: r.handle ?? "" })),
    };
  }

  async leaves(): Promise<Leave[]> {
    const { results } = await this.db
      .prepare("SELECT member_id, from_date, to_date FROM leave")
      .all<{ member_id: string; from_date: string; to_date: string }>();
    return results.map((r) => ({ memberId: r.member_id, from: r.from_date, to: r.to_date }));
  }

  async recent(limit: number): Promise<Facilitation[]> {
    const { results } = await this.db
      .prepare("SELECT date, member_id FROM history ORDER BY date DESC LIMIT ?")
      .bind(limit)
      .all<{ date: string; member_id: string }>();
    return results.map((r) => ({ date: r.date, memberId: r.member_id }));
  }

  async on(date: string): Promise<Facilitation | null> {
    const row = await this.db
      .prepare("SELECT date, member_id FROM history WHERE date = ?")
      .bind(date)
      .first<{ date: string; member_id: string }>();
    return row ? { date: row.date, memberId: row.member_id } : null;
  }

  async record(f: Facilitation): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO history (date, member_id) VALUES (?, ?) " +
          "ON CONFLICT(date) DO UPDATE SET member_id = excluded.member_id",
      )
      .bind(f.date, f.memberId)
      .run();
  }

  async addMember(m: Member): Promise<void> {
    const row = await this.db
      .prepare("SELECT COALESCE(MAX(position), -1) AS maxpos FROM roster")
      .first<{ maxpos: number }>();
    const position = (row?.maxpos ?? -1) + 1;
    // id is PRIMARY KEY, so a duplicate insert fails at the DB. Surface it as a
    // typed error the handler turns into a 409, rather than a raw D1 message.
    const existing = await this.db
      .prepare("SELECT 1 FROM roster WHERE id = ?")
      .bind(m.id)
      .first();
    if (existing) throw new MemberExistsError(m.id);
    await this.db
      .prepare("INSERT INTO roster (id, name, handle, position) VALUES (?, ?, ?, ?)")
      .bind(m.id, m.name, m.handle, position)
      .run();
  }

  async deleteMember(id: string): Promise<void> {
    // Two statements, one batch, so the roster and leave deletions commit atomically.
    await this.db.batch([
      this.db.prepare("DELETE FROM roster WHERE id = ?").bind(id),
      this.db.prepare("DELETE FROM leave WHERE member_id = ?").bind(id),
    ]);
  }

  async renameMember(id: string, name: string, handle: string): Promise<void> {
    await this.db
      .prepare("UPDATE roster SET name = ?, handle = ? WHERE id = ?")
      .bind(name, handle, id)
      .run();
  }

  async setOrder(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.batch(
      ids.map((id, i) => this.db.prepare("UPDATE roster SET position = ? WHERE id = ?").bind(i, id)),
    );
  }

  async addLeave(l: Leave): Promise<void> {
    await this.db
      .prepare("INSERT INTO leave (member_id, from_date, to_date) VALUES (?, ?, ?)")
      .bind(l.memberId, l.from, l.to)
      .run();
  }

  async deleteLeave(l: Leave): Promise<void> {
    await this.db
      .prepare("DELETE FROM leave WHERE member_id = ? AND from_date = ? AND to_date = ?")
      .bind(l.memberId, l.from, l.to)
      .run();
  }

  async getWebhook(): Promise<string> {
    const row = await this.db
      .prepare("SELECT google_chat_webhook FROM settings WHERE id = 1")
      .first<{ google_chat_webhook: string }>();
    return row?.google_chat_webhook ?? "";
  }

  async setWebhook(url: string): Promise<void> {
    // Upsert the singleton so a DB that somehow missed the seed still works.
    await this.db
      .prepare(
        "INSERT INTO settings (id, google_chat_webhook) VALUES (1, ?) " +
          "ON CONFLICT(id) DO UPDATE SET google_chat_webhook = excluded.google_chat_webhook",
      )
      .bind(url)
      .run();
  }

  async getAnnounceTime(): Promise<string> {
    const row = await this.db
      .prepare("SELECT announce_time FROM settings WHERE id = 1")
      .first<{ announce_time: string }>();
    // "09:00" mirrors the schema DEFAULT so a missing row degrades to the default
    // rather than "" (which shouldAnnounce would read as "fire at midnight").
    return row?.announce_time || "09:00";
  }

  async setAnnounceTime(hhmm: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO settings (id, announce_time) VALUES (1, ?) " +
          "ON CONFLICT(id) DO UPDATE SET announce_time = excluded.announce_time",
      )
      .bind(hhmm)
      .run();
  }

  async getLastSentSlot(): Promise<string> {
    const row = await this.db
      .prepare("SELECT last_sent_slot FROM settings WHERE id = 1")
      .first<{ last_sent_slot: string }>();
    return row?.last_sent_slot ?? "";
  }

  async setLastSentSlot(slot: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO settings (id, last_sent_slot) VALUES (1, ?) " +
          "ON CONFLICT(id) DO UPDATE SET last_sent_slot = excluded.last_sent_slot",
      )
      .bind(slot)
      .run();
  }

  async logSend(e: SendLogEntry): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO send_log (sent_at, member_id, member_name, trigger, result, error) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(e.sentAt, e.memberId, e.memberName, e.trigger, e.result, e.error)
      .run();
  }

  async recentSends(limit: number): Promise<SendLogEntry[]> {
    // Newest first. The id tiebreak makes ordering deterministic when two sends
    // share a sent_at second (id is the insertion order, so id DESC == newest).
    const { results } = await this.db
      .prepare(
        "SELECT sent_at, member_id, member_name, trigger, result, error FROM send_log " +
          "ORDER BY sent_at DESC, id DESC LIMIT ?",
      )
      .bind(limit)
      .all<{
        sent_at: string;
        member_id: string;
        member_name: string;
        trigger: string;
        result: string;
        error: string | null;
      }>();
    return results.map((r) => ({
      sentAt: r.sent_at,
      memberId: r.member_id,
      memberName: r.member_name,
      trigger: r.trigger === "auto" ? "auto" : "manual",
      result: r.result === "sent" ? "sent" : "failed",
      error: r.error ?? "",
    }));
  }
}

// MemberExistsError is thrown when an add would collide with an existing id. The
// handler maps it to 409; ids are the stable identity history refers to, so a
// silent overwrite would corrupt the meaning of past picks.
export class MemberExistsError extends Error {
  constructor(id: string) {
    super(`member "${id}" already exists`);
    this.name = "MemberExistsError";
  }
}
