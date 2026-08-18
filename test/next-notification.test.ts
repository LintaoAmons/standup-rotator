// The portal's "Next notification in Xh Ym" countdown (owner ask 2026-08-18). The
// MOMENT is computed server-side by the pure nextNotification(), so the four
// boundaries the owner named are pinned here with no Worker, no clock and no D1 —
// `now` is an injected UTC instant, times are asserted through formatSgt so the
// SGT wall-clock is human-readable in the assertion.
//
// All times below are SGT = UTC+8. Reference weekdays: 2026-08-17 Mon,
// 08-18 Tue, 08-21 Fri, 08-22 Sat, 08-24 Mon (verified: new Date(d+"T00:00:00Z")).

import { describe, expect, it } from "vitest";
import { formatSgt, nextNotification, sendSlot } from "../src/domain";

// sgt(date, hhmm) is the UTC instant whose SGT wall-clock is `date hhmm` — the
// helper the tests use to build a `now` at a known SGT moment (UTC = SGT - 8h).
function sgt(date: string, hhmm: string): Date {
  return new Date(Date.parse(`${date}T${hhmm}:00Z`) - 8 * 60 * 60_000);
}

describe("nextNotification — the four owner boundaries", () => {
  const TIME = "09:00";

  // (a) today's slot not yet sent AND the time is still ahead -> TODAY.
  it("today, slot unsent, before the time -> today at the configured time", () => {
    const now = sgt("2026-08-18", "08:00"); // Tue 08:00 SGT, 09:00 not sent
    const r = nextNotification(now, TIME, /* lastSentSlot */ "", true);
    expect(r.kind).toBe("scheduled");
    if (r.kind !== "scheduled") throw new Error("unreachable");
    expect(formatSgt(r.at.toISOString())).toBe("2026-08-18 09:00");
    expect(r.at.getTime()).toBeGreaterThan(now.getTime()); // genuinely in the future
  });

  // (b) today's slot already sent -> rolls to TOMORROW (next working day).
  it("today's slot already sent -> next working day at the configured time", () => {
    const now = sgt("2026-08-18", "09:30"); // Tue, just after today's send
    const sentToday = sendSlot("2026-08-18", TIME); // "2026-08-18|09:00"
    const r = nextNotification(now, TIME, sentToday, true);
    expect(r.kind).toBe("scheduled");
    if (r.kind !== "scheduled") throw new Error("unreachable");
    expect(formatSgt(r.at.toISOString())).toBe("2026-08-19 09:00"); // Wed
  });

  // (c) Friday already sent -> rolls across the weekend to MONDAY (not Sat/Sun).
  it("Friday's slot sent -> crosses the weekend to Monday", () => {
    const now = sgt("2026-08-21", "10:00"); // Fri, after today's send
    const sentFriday = sendSlot("2026-08-21", TIME);
    const r = nextNotification(now, TIME, sentFriday, true);
    expect(r.kind).toBe("scheduled");
    if (r.kind !== "scheduled") throw new Error("unreachable");
    expect(formatSgt(r.at.toISOString())).toBe("2026-08-24 09:00"); // Mon, not 22/23
  });

  // (d) webhook not configured -> NO countdown, an explicit "no-webhook" instead.
  it("no webhook configured -> no-webhook, never a countdown to a send that can't happen", () => {
    const now = sgt("2026-08-18", "08:00");
    const r = nextNotification(now, TIME, "", /* webhookConfigured */ false);
    expect(r).toEqual({ kind: "no-webhook" });
  });

  // Bonus edge (not one of the four, but guards the "due now" reading): a working
  // day whose time has passed but whose slot is NOT yet sent points at today's
  // (past) instant, so the UI shows "any moment now" rather than skipping to
  // tomorrow — the send is imminent, not a day away.
  it("time passed but slot unsent -> today's instant (imminent), not tomorrow", () => {
    const now = sgt("2026-08-18", "09:03"); // 3 min past 09:00, next tick will send
    const r = nextNotification(now, TIME, "", true);
    expect(r.kind).toBe("scheduled");
    if (r.kind !== "scheduled") throw new Error("unreachable");
    expect(formatSgt(r.at.toISOString())).toBe("2026-08-18 09:00");
    expect(r.at.getTime()).toBeLessThanOrEqual(now.getTime()); // in the past -> "due now"
  });

  // Weekend now -> next working day is Monday (covers the Sat/Sun start, distinct
  // from (c)'s Friday-after-send path).
  it("Saturday now -> Monday at the configured time", () => {
    const now = sgt("2026-08-22", "12:00"); // Sat
    const r = nextNotification(now, TIME, "", true);
    expect(r.kind).toBe("scheduled");
    if (r.kind !== "scheduled") throw new Error("unreachable");
    expect(formatSgt(r.at.toISOString())).toBe("2026-08-24 09:00"); // Mon
  });
});
