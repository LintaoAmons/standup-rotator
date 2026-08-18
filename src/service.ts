// Orchestrates the domain rule against the storage port. No rules of its own —
// every decision here is about ordering and failure handling, not about who
// facilitates. Faithful port of the Go `internal/app` Service.RunStandup.

import {
  dayOf,
  isWorkingDay,
  minuteOf,
  moveAfter,
  next,
  sendSlot,
  shouldAnnounce,
  unavailable,
  type Facilitation,
  type Member,
} from "./domain";
import { chatNotifier } from "./notify";
import type { Repo } from "./repo";

// historyLookback bounds how far back we read to find a still-rostered
// facilitator. It only needs to exceed the number of consecutive departed
// facilitators the log might contain — a handful in practice; the bound keeps a
// years-long history from turning into a full scan.
const historyLookback = 50;

// A pick's delivery channel. Kept as an injected callback so the pure use case
// never imports fetch, and so tests can supply a fake that fails on demand.
export type Notify = (f: Facilitation, m: Member) => Promise<void>;

export interface Result {
  facilitation: Facilitation;
  member: Member;
  // fresh distinguishes a new pick from an idempotent replay of one already
  // recorded for that date.
  fresh: boolean;
  // notifyError is set when the pick was committed but its announcement failed.
  // The pick still stands — see the ordering note below — so this is reported,
  // not thrown: a chat outage must never roll back a recorded rotation, and must
  // never fail a cron invocation into a retry that would re-pick.
  notifyError?: string;
}

// runStandup picks, records and (optionally) announces the facilitator for a date.
//
// Order is deliberate: check idempotency -> pick -> record history -> notify.
// History is committed BEFORE the notification so a delivery failure can never
// cause the same person to be picked twice. The cost is a rare
// recorded-but-undelivered standup, which a human notices within minutes; the
// alternative failure mode is a silently corrupted rotation nobody notices for
// weeks.
//
// force=false makes a same-day re-run a no-op returning the existing pick — what
// lets cron, the GET /today endpoint and a repeated call all fire on one morning
// without picking twice. force=true rerolls: because recent() then includes the
// day's current row as the newest anchor, next() returns the following member,
// and record() replaces the row — this is exactly the /skip semantics.
//
// notify is invoked ONLY on a fresh pick. A replay announces nothing.
export async function runStandup(
  repo: Repo,
  date: string,
  force: boolean,
  notify?: Notify,
): Promise<Result> {
  if (!force) {
    const existing = await repo.on(date);
    if (existing) {
      const m = await member(repo, existing.memberId);
      return { facilitation: existing, member: m, fresh: false };
    }
  }

  const roster = await repo.roster();
  const leaves = await repo.leaves();
  const recent = await repo.recent(historyLookback);

  const picked = next(roster, recent, unavailable(leaves, date));
  const f: Facilitation = { date, memberId: picked.id };

  // A record failure throws: nothing has been announced, so the run left no
  // trace and is safe to retry. (Contrast notify below, which is non-fatal.)
  await repo.record(f);

  const result: Result = { facilitation: f, member: picked, fresh: true };
  if (notify) {
    try {
      await notify(f, picked);
    } catch (e) {
      result.notifyError = e instanceof Error ? e.message : String(e);
    }
  }
  return result;
}

// SkipMode is the owner's two kinds of skip (second kind added 2026-08-18):
//
//   "requeue" — skip·顺延 (goes next): the skipped person is bumped to the FRONT
//               of the queue (right behind today's replacement) and facilitates
//               the next working day. Mutates the rotation order.
//   "pass"    — skip·这轮直接过 (pass): the skipped person is NOT requeued. The
//               rotation order is left completely untouched; the rotation simply
//               continues from the replacement, so the skipped person waits their
//               natural turn (they come back around after a full cycle).
//
// Both record the replacement for today identically — the ONLY difference is the
// moveAfter reorder, which "pass" omits. That single-line divergence is exactly
// what the paired contrast tests pin, because it is the thing that regresses
// silently if the two modes are ever collapsed back into one.
export type SkipMode = "requeue" | "pass";

// skipStandup performs a /skip as one orchestration step so it is testable
// without the Worker HTTP layer. The current facilitator steps aside and the next
// available member takes today (force reroll, which replaces the day's row). Then,
// for mode "requeue" only, the person who stepped aside is requeued as NEXT —
// moved immediately behind the replacement in the rotation order, so tomorrow's
// history-anchored next() lands on them instead of letting them sink to the back
// of the cycle. For mode "pass" the order is left as-is. The reorder is a no-op
// anyway when nobody actually changed (single-member roster, or everyone else on
// leave so the reroll returned the same person). Returns the replacement's Result.
export async function skipStandup(
  repo: Repo,
  date: string,
  mode: SkipMode = "requeue",
): Promise<Result> {
  const before = await runStandup(repo, date, false); // who is stepping aside
  const after = await runStandup(repo, date, true); // replacement, recorded for today
  if (mode === "requeue" && after.member.id !== before.member.id) {
    const order = (await repo.roster()).members.map((m) => m.id);
    await repo.setOrder(moveAfter(order, before.member.id, after.member.id));
  }
  return after;
}

// TickResult reports what a scheduled tick decided. fired=false is the common
// case (weekend, before the configured time, or this (date, time) slot already
// sent) — no send happened (rotation may still have advanced). fired=true carries
// the pick that was announced and any delivery error.
export interface TickResult {
  fired: boolean;
  result?: Result;
  notifyError?: string;
}

// announceAndLog is the ONE send-and-record step both delivery paths share (the
// scheduled tick below and POST /trigger in the Worker), so the send-log audit
// cannot drift between "auto" and "manual". It performs the single webhook POST,
// captures success or failure, and writes exactly one send_log row for the
// outcome — a failed send is logged too, because that is the half the owner wants
// to see. Callers invoke this ONLY when a webhook is configured: a missing webhook
// sends nothing and so must log nothing. `at` is the send instant (UTC is stored;
// the portal renders SGT) — injected, not read from a clock, so this is testable.
// Returns the delivery error message, or undefined on success.
export async function announceAndLog(
  repo: Repo,
  notify: Notify,
  f: Facilitation,
  m: Member,
  trigger: "auto" | "manual",
  at: Date,
): Promise<string | undefined> {
  let error: string | undefined;
  try {
    await notify(f, m);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await repo.logSend({
    sentAt: at.toISOString(),
    memberId: m.id,
    memberName: m.name || m.id, // snapshot; a departed member is logged by id
    trigger,
    result: error ? "failed" : "sent",
    error: error ?? "",
  });
  return error;
}

// runScheduledTick is the every-5-min cron body, extracted from the Worker so the
// decoupled rotation + slot-gated send is testable against MemoryRepo with an
// injected clock (no Worker runtime, no real cron).
//
// The two halves are DECOUPLED (owner rule 2026-08-18, "发送和轮换解耦"):
//
//   ROTATION runs on EVERY working-day tick, independent of the send: it ensures
//   today has a pick via the existing idempotent daily advance (runStandup with
//   force=false, no notify). Weekends are skipped so no weekend pick pollutes the
//   history that anchors Monday. The pick is created by the first tick of the SGT
//   day — long before the send time — because the send below is a pure projection
//   of it, not its cause.
//
//   SEND is a pure projection: when the slot gate opens it reads today's already-
//   picked person and broadcasts them. It NEVER advances rotation and is never
//   blocked by rotation state. The gate fires once per (date, configured-time)
//   slot, so editing the announce time re-arms the send the same day ("每次都发")
//   — see sendSlot/shouldAnnounce. lastSentSlot is stamped after the attempt so
//   the same slot stays silent; a delivery failure is reported, never retried
//   into a re-send, matching the recorded-but-undelivered trade-off runStandup
//   already makes.
//
// The announcement is sent explicitly here (like POST /trigger), NOT via
// runStandup's fresh-only notify: the pick usually already exists for today (an
// earlier tick, GET /today, or /trigger created it), and the broadcast must still
// go out.
export async function runScheduledTick(repo: Repo, now: Date): Promise<TickResult> {
  const date = dayOf(now);
  if (!isWorkingDay(date)) return { fired: false }; // weekends: no rotation, no send (SGT day)

  // Rotation half — advance/ensure today's pick every tick, idempotently. This
  // writes rotation; the send below never does.
  const result = await runStandup(repo, date, false); // ensure the pick; do not notify here

  // Send half — slot gate. Reads the pick, writes no rotation.
  const announceTime = await repo.getAnnounceTime();
  const lastSentSlot = await repo.getLastSentSlot();
  if (!shouldAnnounce(minuteOf(now), announceTime, date, lastSentSlot)) {
    return { fired: false };
  }

  const notify = chatNotifier(await repo.getWebhook());
  // Only a real POST is logged: notify is undefined when no webhook is configured,
  // so that path sends nothing and writes no send_log row (skip != send).
  let notifyError: string | undefined;
  if (notify) {
    notifyError = await announceAndLog(repo, notify, result.facilitation, result.member, "auto", now);
  }
  // Stamp THIS slot AFTER the send attempt: the broadcast happened (or was
  // attempted with no webhook, or failed) — this (date, time) is done, but a
  // later time edit mints a new slot and re-arms.
  await repo.setLastSentSlot(sendSlot(date, announceTime));
  return { fired: true, result, notifyError };
}

// member resolves an id recorded in history back to a roster entry. A member who
// has since left the team is reported by id, because history stays truthful
// about picks the roster no longer explains.
async function member(repo: Repo, id: string): Promise<Member> {
  const roster = await repo.roster();
  const found = roster.members.find((m) => m.id === id);
  return found ?? { id, name: id, handle: "" };
}
