// The standup rotation rules — pure, no I/O, no clock, no config.
//
// This module is a faithful TypeScript port of the Go `internal/domain` package
// from the original standup-rotator. It imports nothing else in the project, so
// the rules can be exercised with no D1, no fetch and no Worker runtime — and so
// swapping storage never touches the rule that decides who facilitates.
//
// Dates are carried as `YYYY-MM-DD` strings throughout. That string form sorts
// lexically the same as it sorts chronologically, which is what lets history be
// ordered and leave intervals be compared with plain string comparison — no Date
// object, no timezone ambiguity inside the rules.

// Member is a person eligible to facilitate.
export interface Member {
  // id is the stable identity. History refers to members by id and nothing else,
  // so a rename never rewrites the past.
  id: string;
  // name is display-only.
  name: string;
  // handle addresses the member in a notification channel (e.g. a Google Chat
  // user id). Channel-specific by nature, so it lives on the member.
  handle: string;
}

// Roster is the rotation, in order. The order IS the rotation order — it is data
// the storage layer must preserve (D1: `ORDER BY position`), not an artefact of
// row read order.
export interface Roster {
  members: Member[];
}

// Leave marks a member unavailable over a closed date interval [from, to].
// Stored as an interval rather than an "out today" boolean so the same record
// answers availability for any date — including replaying a past standup, which
// a boolean would silently answer with today's truth.
export interface Leave {
  memberId: string;
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
}

// Facilitation is one standup that happened. This log is the ONLY source of "who
// went last"; there is deliberately no last_facilitator field anywhere, because
// a derived value that is also stored eventually disagrees with its source.
export interface Facilitation {
  date: string; // YYYY-MM-DD
  memberId: string;
}

// Surfaced as typed errors rather than an arbitrary pick: a rotation that cannot
// produce a facilitator is a fact a human needs to see, not one to paper over.
export class EmptyRosterError extends Error {
  constructor() {
    super("roster is empty");
    this.name = "EmptyRosterError";
  }
}
export class AllOnLeaveError extends Error {
  constructor() {
    super("every member of the roster is on leave");
    this.name = "AllOnLeaveError";
  }
}

// indexOf returns a member's position in the roster, or -1 when not rostered.
function indexOf(r: Roster, memberId: string): number {
  return r.members.findIndex((m) => m.id === memberId);
}

// next picks the facilitator that follows the given history.
//
// Pure by construction. This function is the entire product rule, and keeping it
// pure is what makes the rule testable rather than merely observable.
//
// history is newest-first and may be empty. It is a list rather than a single
// "last facilitator" because of the departed-facilitator case: once someone
// leaves the team their roster position is gone, and the only way to resume the
// rotation where it actually stood — instead of restarting at the top — is to
// fall back to the most recent facilitator who is still rostered.
//
// out holds the member ids unavailable for this standup (a Set — membership is
// the only question asked of it).
//
//   - empty roster              -> EmptyRosterError
//   - no usable history         -> the first available member
//   - last facilitator departed -> resume after the newest still-rostered
//                                   facilitator, never from the top
//   - everyone on leave         -> AllOnLeaveError, never an arbitrary pick
//   - single-member roster      -> that member repeats; legal, not an error
export function next(r: Roster, history: Facilitation[], out: Set<string>): Member {
  const n = r.members.length;
  if (n === 0) throw new EmptyRosterError();

  // Anchor on the newest facilitation whose member is still rostered, and start
  // scanning just after them. When no history entry is still rostered — the
  // no-history case included — start stays at the top of the roster.
  let start = 0;
  for (const f of history) {
    const i = indexOf(r, f.memberId);
    if (i >= 0) {
      start = i + 1;
      break;
    }
  }

  // Walk the whole roster once from the anchor, wrapping. Bounding the walk by
  // roster length turns "everybody is on leave" into an error rather than an
  // infinite loop.
  for (let step = 0; step < n; step++) {
    const m = r.members[(start + step) % n];
    if (!out.has(m.id)) return m;
  }
  throw new AllOnLeaveError();
}

// moveInOrder returns a new rotation order with `id` shifted one slot in the
// given direction (-1 = earlier, +1 = later). Pure: the reorder rule lives here,
// not in the storage layer, so "what the new order is" is unit-testable without a
// database. A no-op (id absent, or already at the boundary) returns the order
// unchanged — the caller may persist it either way; persisting the same order is
// harmless. The rotation order is the only mutable thing about a roster that has
// a rule, which is why this is the one CRUD operation with a domain function.
export function moveInOrder(order: string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id);
  if (i < 0) return order.slice();
  const j = i + dir;
  if (j < 0 || j >= order.length) return order.slice();
  const next = order.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// moveAfter returns a new rotation order with `movedId` relocated to immediately
// after `afterId`. This encodes the skip rule owner changed on 2026-08-18: when
// today's facilitator steps aside, the replacement runs today and the skipped
// person is queued for the NEXT working day — inserted right behind the
// replacement — rather than sinking to the back of the rotation to wait a whole
// cycle. Persisting this move is what lets the history-anchored next() surface
// the skipped person first tomorrow with NO change to next() itself: next()
// anchors on the replacement (today's recorded pick) and the member after them
// in the stored order is now the skipped person.
//
// Trade-off, recorded as a deliberate choice (not a bug): a skip permanently
// rewrites the operator-curated rotation order, visible on the page — what you
// see is what you get. If that mutation ever proves surprising, the fallback is a
// one-shot deferral state that leaves the base order untouched; that is a larger
// change and was not taken here.
//
// Pure; a no-op (either id absent, or the two equal) returns the order unchanged.
export function moveAfter(order: string[], movedId: string, afterId: string): string[] {
  if (movedId === afterId) return order.slice();
  if (order.indexOf(movedId) < 0 || order.indexOf(afterId) < 0) return order.slice();
  const without = order.filter((id) => id !== movedId);
  const at = without.indexOf(afterId);
  without.splice(at + 1, 0, movedId);
  return without;
}

// covers reports whether this leave makes the member unavailable on date.
// String comparison is a valid date comparison because the format is YYYY-MM-DD.
export function covers(l: Leave, date: string): boolean {
  return l.from <= date && date <= l.to;
}

// unavailable reduces leave records to the set of member ids out on a date.
// Lives beside next because it is the same rule over a different shape: storage
// supplies intervals, the rotation wants a set.
export function unavailable(leaves: Leave[], date: string): Set<string> {
  const out = new Set<string>();
  for (const l of leaves) {
    if (covers(l, date)) out.add(l.memberId);
  }
  return out;
}

// The standup calendar day is reckoned in this zone — NOT in UTC.
//
// Cloudflare cron fires in UTC and the team is in Singapore (SGT = UTC+8). A day
// derived from UTC would name yesterday's facilitator for any trigger at or after
// 16:00 UTC (= midnight SGT), so an evening-UTC cron would silently rotate to the
// wrong person. Singapore has observed no daylight saving since 1982 and has been
// a fixed UTC+8 throughout, so a constant offset is exact — no zone database, no
// DST edge. Change this one constant to relocate the team.
export const STANDUP_UTC_OFFSET_MINUTES = 8 * 60; // Asia/Singapore

// dayOf truncates an instant to its calendar date in the standup's zone. Shifting
// the instant by the zone offset and then reading its UTC Y-M-D yields the local
// calendar date; normalising here is what keeps the same-day idempotency check
// honest against a UTC cron. offsetMinutes is injectable for testing other zones.
export function dayOf(t: Date, offsetMinutes: number = STANDUP_UTC_OFFSET_MINUTES): string {
  return new Date(t.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

// ---- configurable announcement time (owner ask, 2026-08-18) -----------------
//
// The daily announcement time is portal-editable (stored in D1 settings), not
// baked into the cron. Cloudflare cron is static at deploy time, so the cron is
// set to a HIGH frequency (every 5 min) and the actual send decision is a RUNTIME
// gate here: fire only when the SGT wall clock has reached the configured HH:MM
// and the current (date, time) slot has not been sent yet. Send is decoupled from
// rotation (owner 2026-08-18): editing the time re-arms the send for the same day
// ("每次都发"). These helpers are the whole gate — pure, so the "1 min early / on
// time / late catch-up / re-arm on time change" behaviour is unit-testable with
// no Worker, no clock and no D1.

// minuteOf truncates an instant to its wall-clock HH:MM in the standup's zone —
// the same offset shift as dayOf. Zero-padded fixed width (from toISOString), so
// a plain string compare against the configured HH:MM is a valid time compare.
export function minuteOf(t: Date, offsetMinutes: number = STANDUP_UTC_OFFSET_MINUTES): string {
  return new Date(t.getTime() + offsetMinutes * 60_000).toISOString().slice(11, 16);
}

// formatSgt renders a stored UTC instant as its SGT wall-clock string, for the
// portal's Sent history. Storage is UTC (unambiguous across the world); display is
// SGT (what the team reads) — the same fixed +8 offset as dayOf/minuteOf, no zone
// database. Output "YYYY-MM-DD HH:MM" so it reads and sorts like the rest of the UI.
// offsetMinutes is injectable so the SGT-shift itself is unit-testable.
export function formatSgt(iso: string, offsetMinutes: number = STANDUP_UTC_OFFSET_MINUTES): string {
  const shifted = new Date(new Date(iso).getTime() + offsetMinutes * 60_000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)}`;
}

// isValidTime accepts exactly zero-padded 24h HH:MM (00:00–23:59). Strict padding
// is required, not cosmetic: the gate compares times as strings, so "9:00" would
// sort AFTER "10:00" and break the comparison. Rejecting "25:00", "", "9:00" at
// the portal keeps only compare-safe values in D1.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function isValidTime(s: string): boolean {
  return TIME_RE.test(s);
}

// sendSlot is the send gate's idempotency key: the (date, configured-time) pair,
// joined as "YYYY-MM-DD|HH:MM". The gate fires ONCE per slot. Owner rule
// 2026-08-18 ("每次都发 / 发送和轮换解耦"): the send key embeds the configured
// TIME, not just the date, so editing the announcement time mints a NEW slot and
// re-arms the send for the SAME day — change the time three times, it sends three
// times. The old date-only "announced_date" key (once per day) is retired; there
// is no last_facilitator-style derived-and-stored duplicate to drift.
export function sendSlot(today: string, announceTime: string): string {
  return `${today}|${announceTime}`;
}

// shouldAnnounce is the whole "should this tick broadcast?" predicate. It fires
// when, in SGT: today is a working day, the wall clock has reached the configured
// time, and the CURRENT (date, time) slot has not been broadcast yet.
//
// Why the working-day check lives HERE and not in the cron: the cron is a plain
// heartbeat that fires on UTC days, but a UTC weekday does NOT equal an SGT
// weekday at the edges — SGT Mon 00:00–07:59 is still Sunday UTC, and Friday
// evening UTC is already Saturday SGT. Pinning the cron to `1-5` (UTC) would both
// miss early-Monday SGT times and leak into Saturday SGT. So the cron runs every
// day and this gate — reckoning the day in SGT via isWorkingDay(today) — is the
// single authority on working-day-only, avoiding that timezone skew entirely.
//
// lastSentSlot is the last slot the scheduled path broadcast (see sendSlot) — the
// send's OWN idempotency key, deliberately SEPARATE from pick history: this gate
// governs the SEND, never the rotation (owner decoupled the two 2026-08-18). The
// re-arm is the point: because the slot embeds the configured time, editing that
// time to a NEW value — even one already past on the SGT clock — makes
// lastSentSlot != the new slot, so the next tick fires again the same day.
// Editing back to a time already sent this day does NOT re-fire (its slot is
// still recorded). Late ticks within a slot still catch up (any tick past the
// time on a not-yet-sent slot fires once, then that slot closes).
export function shouldAnnounce(
  nowHHMM: string,
  announceTime: string,
  today: string,
  lastSentSlot: string,
): boolean {
  if (!isWorkingDay(today)) return false; // weekends never announce (SGT day)
  if (nowHHMM < announceTime) return false; // still before the configured time
  if (lastSentSlot === sendSlot(today, announceTime)) return false; // this slot already sent
  return true;
}

// ---- forward prediction (display-only) -------------------------------------
//
// The "Next up" panel added 2026-08-18: show who facilitates the coming working
// days so the team can see the queue, and so a skip's effect is visible
// immediately (the skipped person becomes the first prediction — see moveAfter).
// This is projection, never persistence: predict() writes nothing and records
// nothing, it only replays the same next() rule forward.

// isWorkingDay reports whether a YYYY-MM-DD falls Mon–Fri. The standup cron runs
// Mon–Fri (see wrangler.jsonc "0 1 * * 1-5"), so the prediction lists only those
// days. A YYYY-MM-DD read at midnight UTC has the calendar weekday directly —
// there is no wall-clock, so no timezone shift is needed here.
export function isWorkingDay(date: string): boolean {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  return dow >= 1 && dow <= 5;
}

// addDays returns the calendar date `n` days after `date` (YYYY-MM-DD in and out).
export function addDays(date: string, n: number): string {
  const t = new Date(date + "T00:00:00Z").getTime() + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// Prediction is one projected future standup. member is null when the roster is
// empty or everyone is on leave that day — surfaced rather than thrown, because a
// projection panel must render the whole horizon, gaps included.
export interface Prediction {
  date: string;
  member: Member | null;
}

// predict projects the next `count` working days AFTER `fromDate`, applying the
// same next() rule day by day and feeding each projected pick back into the
// history so the following day advances past it. Pure and side-effect free.
// Because a skip reorders the roster (moveAfter) and records the replacement for
// today, the skipped person appears here as the first prediction with no special
// case. Members on leave for a given day are stepped over by next(); a day on
// which everyone is on leave yields member: null and does not advance the anchor.
export function predict(
  roster: Roster,
  history: Facilitation[],
  leaves: Leave[],
  fromDate: string,
  count: number,
): Prediction[] {
  const out: Prediction[] = [];
  const simHistory = history.slice(); // newest-first; each projected pick is unshifted on
  let date = fromDate;
  // Bound the walk so weekends plus an unusable roster can never loop forever:
  // at most `count` working days sit within count + a fortnight of calendar days.
  for (let guard = 0; out.length < count && guard < count + 21; guard++) {
    date = addDays(date, 1);
    if (!isWorkingDay(date)) continue;
    let member: Member | null;
    try {
      member = next(roster, simHistory, unavailable(leaves, date));
    } catch {
      member = null; // EmptyRosterError or AllOnLeaveError — a gap in the horizon
    }
    if (member) simHistory.unshift({ date, memberId: member.id });
    out.push({ date, member });
  }
  return out;
}
