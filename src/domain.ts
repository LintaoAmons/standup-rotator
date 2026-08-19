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

// ---- next-notification indicator (display-only, owner ask 2026-08-18) --------
//
// The portal shows a live "Next notification in Xh Ym" countdown beside the
// settings. The MOMENT is computed HERE, server-side, from the SAME send
// semantics the scheduled gate uses (working-day + configured time + whether this
// (date, time) slot was already sent, all reckoned in SGT), so the browser never
// reimplements the gate — the embedded JS only counts down to the instant this
// returns. Pure: `now` is injected, no D1, no clock of its own, so the four
// boundaries below are unit-testable.
//
//   - webhook not configured -> { kind: "no-webhook" }. Counting down to a send
//     that cannot happen (announce is off) is a lie, so the indicator says so
//     instead — this is the owner's explicit rule, not a fallback.
//   - today is a working day AND this (date, time) slot is not yet sent ->
//     today at the configured time. If that instant is already past (the ≤5-min
//     window between the time and the next cron tick, or a stalled roster) it is
//     returned unchanged so the UI reads "due now" — the send really is imminent,
//     not tomorrow.
//   - today's slot already sent, OR today is a weekend -> the next working day at
//     the configured time (a Friday already-sent and Sat/Sun all roll to Monday).
//
// The returned instant is a UTC Date (what the browser's Date math wants); it is
// the SGT wall-clock `announceTime` on the chosen calendar day, converted back to
// UTC by the same fixed offset as dayOf/minuteOf. The `lastSentSlot` argument is
// the send's own idempotency key (see sendSlot) — the indicator is a projection
// of the send gate and reads that same state, never rotation history.
export type NextNotification =
  | { kind: "no-webhook" }
  | { kind: "scheduled"; at: Date };

export function nextNotification(
  now: Date,
  announceTime: string,
  lastSentSlot: string,
  webhookConfigured: boolean,
  offsetMinutes: number = STANDUP_UTC_OFFSET_MINUTES,
): NextNotification {
  if (!webhookConfigured) return { kind: "no-webhook" };
  const today = dayOf(now, offsetMinutes);
  // "Pending today" mirrors shouldAnnounce's slot check exactly (minus the time
  // comparison): today still owes a send iff it is a working day and this slot has
  // not gone out. When it does not, walk forward to the next working day.
  const pendingToday = isWorkingDay(today) && lastSentSlot !== sendSlot(today, announceTime);
  let day = today;
  if (!pendingToday) {
    do {
      day = addDays(day, 1);
    } while (!isWorkingDay(day));
  }
  return { kind: "scheduled", at: sgtWallClockToInstant(day, announceTime, offsetMinutes) };
}

// sgtWallClockToInstant maps an SGT calendar date + HH:MM to the UTC instant it
// denotes — the inverse of the dayOf/minuteOf shift. SGT = UTC + offset, so the
// UTC instant is that Y-M-D-H-M read as if it were UTC, shifted back by the offset.
function sgtWallClockToInstant(date: string, hhmm: string, offsetMinutes: number): Date {
  const asUtc = Date.parse(`${date}T${hhmm}:00Z`);
  return new Date(asUtc - offsetMinutes * 60_000);
}

// ---- month calendar (display-only, owner ask 2026-08-19) --------------------
//
// The portal's /calendar view: a Mon–Sun month grid showing who facilitates each
// day. It is a PURE PROJECTION with exactly ONE authority per day, never a second
// rotation engine — that is the whole point of the owner's acceptance rule:
//
//   past working day  -> the RECORDED pick (history row for that date). What
//                        actually happened; a rename never rewrites it (member_id).
//   today             -> `todayPick` (repo.on(today)) — the SAME value the portal's
//                        top "Today" line renders. Passed in, never re-derived, so
//                        the today cell and the Today line CANNOT disagree (owner's
//                        added criterion). Null (== "not picked yet") stays null.
//   future working day-> predict() replayed forward. Reuses the one rotation rule;
//                        no parallel computation to drift from real broadcasts.
//   weekend           -> blank (no pick, no send). Reckoned by isWorkingDay.
//
// The junction (today | tomorrow) is exactly why predict() is anchored on history
// that INCLUDES today's recorded pick: predict(fromDate = today) projects strictly
// AFTER today, so tomorrow correctly follows today's recorded person with no
// special-case seam. Cross-month edges fall out of plain YYYY-MM-DD arithmetic —
// leading/trailing padding days carry inMonth:false but are otherwise real cells.
// Both seams are unit-tested by name (calendar.test.ts) per the owner's ask.

// MonthCell is one square of the grid. member is null for weekends, gaps
// (a past day with no recorded pick, e.g. before the project started or all on
// leave), and a not-yet-picked today. origin records provenance for styling and
// for the tests to assert which authority filled the cell.
export interface MonthCell {
  date: string; // YYYY-MM-DD
  inMonth: boolean; // false = padding day from the previous/next month
  weekend: boolean;
  isToday: boolean;
  member: Member | null;
  origin: "history" | "today" | "predicted" | null;
  sent: boolean; // a successful send_log delivery exists for this SGT date
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// mondayIndex maps a date to its column in a Mon-first week: Mon=0 … Sun=6.
// getUTCDay is Sun=0 … Sat=6, so (+6)%7 rotates Monday to zero.
function mondayIndex(date: string): number {
  return (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
}

// daysInMonth for a 1-based month. Date.UTC(year, month, 0) is day 0 of the NEXT
// month — i.e. the last day of `month` — whose getUTCDate is the day count.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// resolveMember maps an id to its roster entry, falling back to a name==id stub
// for a departed member still named in history (same "history never lies" rule as
// the rest of the app — a past pick stays truthful after the member is deleted).
function resolveMember(roster: Roster, id: string): Member {
  return roster.members.find((m) => m.id === id) ?? { id, name: id, handle: "" };
}

// buildMonth assembles the whole visible grid for (year, month) — leading days
// back to the Monday on/before the 1st, the month itself, then trailing days out
// to the Sunday on/after the last. Pure: every input is plain data (history is
// newest-first from repo.recent; sentDates is the set of SGT dates that had a
// successful send; todayPick is repo.on(today)), so the junction and month-edge
// behaviour is testable with no D1 and no Worker.
export function buildMonth(
  roster: Roster,
  history: Facilitation[],
  leaves: Leave[],
  sentDates: Set<string>,
  today: string,
  todayPick: Facilitation | null,
  year: number,
  month: number, // 1-12
): MonthCell[] {
  const first = `${year}-${pad2(month)}-01`;
  const dim = daysInMonth(year, month);
  const last = `${year}-${pad2(month)}-${pad2(dim)}`;
  const leading = mondayIndex(first); // days of the prev month shown before the 1st
  const trailing = 6 - mondayIndex(last); // days of the next month after the last
  const gridStart = addDays(first, -leading);
  const totalDays = leading + dim + trailing;
  const gridEnd = addDays(gridStart, totalDays - 1);

  // history lookup: one recorded pick per day (history.date is UNIQUE).
  const recorded = new Map<string, string>();
  for (const f of history) if (!recorded.has(f.date)) recorded.set(f.date, f.memberId);

  // Future half — replay the rotation forward from today. Ask for exactly the
  // number of working days between tomorrow and the grid's end, so the projection
  // covers the visible future and no more. predict() anchors on `history`, which
  // includes today's pick, so predict[0] is tomorrow's facilitator (the seam).
  let need = 0;
  for (let d = today; d < gridEnd; ) {
    d = addDays(d, 1);
    if (isWorkingDay(d)) need++;
  }
  const predMap = new Map<string, Member>();
  for (const p of predict(roster, history, leaves, today, need)) {
    if (p.member) predMap.set(p.date, p.member);
  }

  const cells: MonthCell[] = [];
  for (let i = 0; i < totalDays; i++) {
    const date = addDays(gridStart, i);
    const weekend = !isWorkingDay(date);
    const isToday = date === today;
    let member: Member | null = null;
    let origin: MonthCell["origin"] = null;
    if (!weekend) {
      if (date < today) {
        const id = recorded.get(date);
        if (id) {
          member = resolveMember(roster, id);
          origin = "history";
        }
      } else if (isToday) {
        if (todayPick) {
          member = resolveMember(roster, todayPick.memberId);
          origin = "today";
        }
      } else {
        const p = predMap.get(date);
        if (p) {
          member = p;
          origin = "predicted";
        }
      }
    }
    cells.push({
      date,
      inMonth: date >= first && date <= last,
      weekend,
      isToday,
      member,
      origin,
      sent: !weekend && sentDates.has(date),
    });
  }
  return cells;
}
