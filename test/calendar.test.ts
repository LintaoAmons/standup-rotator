// The month-calendar builder (buildMonth). The owner named two hard spots to
// cover by name: the JUNCTION where today's recorded pick meets tomorrow's
// prediction, and the CROSS-MONTH edge. The load-bearing acceptance rule is that
// the "today" cell is the SAME person the portal's Today line shows — i.e. it
// comes from todayPick, never from a parallel computation.

import { describe, expect, it } from "vitest";
import {
  buildMonth,
  isWorkingDay,
  next,
  type Facilitation,
  type Roster,
} from "../src/domain";

function roster(...ids: string[]): Roster {
  return { members: ids.map((id) => ({ id, name: id.toUpperCase(), handle: "" })) };
}

// newest-first history from (date, id) pairs given oldest-first.
function hist(...rows: [string, string][]): Facilitation[] {
  return rows.map(([date, memberId]) => ({ date, memberId })).reverse();
}

const R = roster("ana", "bo", "cy");
// A run of recorded picks Mon 2026-08-17 → Wed 2026-08-19 (today). 08-19 is a
// Wednesday working day; the fixture asserts that so the dates stay meaningful.
const TODAY = "2026-08-19";
const RECENT = hist(
  ["2026-08-17", "ana"], // Mon
  ["2026-08-18", "bo"], // Tue
  ["2026-08-19", "cy"], // Wed (today)
);
const TODAY_PICK: Facilitation = { date: TODAY, memberId: "cy" };

function cellFor(cells: ReturnType<typeof buildMonth>, date: string) {
  return cells.find((c) => c.date === date)!;
}

describe("buildMonth — grid shape", () => {
  it("today's fixture date really is a working day", () => {
    expect(isWorkingDay(TODAY)).toBe(true);
  });

  it("starts on a Monday and is a whole number of weeks", () => {
    const cells = buildMonth(R, RECENT, [], new Set(), TODAY, TODAY_PICK, 2026, 8);
    expect(cells.length % 7).toBe(0);
    // Monday-first: getUTCDay of the first cell is 1 (Monday).
    expect(new Date(cells[0].date + "T00:00:00Z").getUTCDay()).toBe(1);
    // The 1st of the month is present and flagged inMonth.
    expect(cellFor(cells, "2026-08-01").inMonth).toBe(true);
    expect(cellFor(cells, "2026-08-31").inMonth).toBe(true);
  });
});

describe("buildMonth — acceptance: today cell == todayPick (the Today line)", () => {
  it("today's cell shows exactly todayPick's member, tagged origin 'today'", () => {
    const cells = buildMonth(R, RECENT, [], new Set(), TODAY, TODAY_PICK, 2026, 8);
    const t = cellFor(cells, TODAY);
    expect(t.isToday).toBe(true);
    expect(t.origin).toBe("today");
    expect(t.member?.id).toBe("cy"); // same id the Today line resolves
  });

  it("when today is not picked yet, the today cell is blank — NOT the predicted person", () => {
    // The whole point of the criterion: today is NEVER filled by predict(). With
    // no recorded pick the Today line reads "not picked yet", so the cell must be
    // blank too, even though predict() would happily name someone for today.
    const cells = buildMonth(R, RECENT.slice(1), [], new Set(), TODAY, null, 2026, 8);
    const t = cellFor(cells, TODAY);
    expect(t.member).toBeNull();
    expect(t.origin).toBeNull();
  });
});

describe("buildMonth — the junction (today | tomorrow)", () => {
  it("tomorrow follows today's RECORDED pick via the one rotation rule", () => {
    const cells = buildMonth(R, RECENT, [], new Set(), TODAY, TODAY_PICK, 2026, 8);
    const tomorrow = cellFor(cells, "2026-08-20"); // Thu
    expect(tomorrow.origin).toBe("predicted");
    // Independently: next() anchored on the history that includes today (cy) is
    // ana. The calendar must agree — it reuses predict(), which reuses next().
    const expected = next(R, RECENT, new Set());
    expect(expected.id).toBe("ana");
    expect(tomorrow.member?.id).toBe("ana");
  });

  it("past working days read the recorded history, not a prediction", () => {
    const cells = buildMonth(R, RECENT, [], new Set(), TODAY, TODAY_PICK, 2026, 8);
    expect(cellFor(cells, "2026-08-17")).toMatchObject({ origin: "history", member: { id: "ana" } });
    expect(cellFor(cells, "2026-08-18")).toMatchObject({ origin: "history", member: { id: "bo" } });
  });

  it("a past working day with no recorded pick is a gap (null), not back-filled", () => {
    // 08-14 (Fri) precedes any history row — before the project started.
    const cells = buildMonth(R, RECENT, [], new Set(), TODAY, TODAY_PICK, 2026, 8);
    const gap = cellFor(cells, "2026-08-14");
    expect(gap.weekend).toBe(false);
    expect(gap.member).toBeNull();
    expect(gap.origin).toBeNull();
  });
});

describe("buildMonth — weekends and sent marks", () => {
  it("weekends carry no member and are never marked sent", () => {
    const cells = buildMonth(R, RECENT, [], new Set(["2026-08-22"]), TODAY, TODAY_PICK, 2026, 8);
    const sat = cellFor(cells, "2026-08-22");
    const sun = cellFor(cells, "2026-08-23");
    expect(sat.weekend).toBe(true);
    expect(sat.member).toBeNull();
    expect(sat.sent).toBe(false); // even though 08-22 is in the sentDates set
    expect(sun.weekend).toBe(true);
  });

  it("a working day in the sentDates set is marked sent", () => {
    const cells = buildMonth(R, RECENT, [], new Set(["2026-08-18"]), TODAY, TODAY_PICK, 2026, 8);
    expect(cellFor(cells, "2026-08-18").sent).toBe(true);
    expect(cellFor(cells, "2026-08-17").sent).toBe(false);
  });
});

describe("buildMonth — cross-month boundary", () => {
  it("trailing days belong to the next month (inMonth:false) and predictions run through the seam", () => {
    const cells = buildMonth(R, RECENT, [], new Set(), TODAY, TODAY_PICK, 2026, 8);
    const aug31 = cellFor(cells, "2026-08-31"); // Mon, last of August
    const sep01 = cellFor(cells, "2026-09-01"); // Tue, first of September (trailing pad)
    expect(aug31.inMonth).toBe(true);
    expect(sep01.inMonth).toBe(false);
    // Both are future working days → predicted, and consecutive in the rotation.
    expect(aug31.origin).toBe("predicted");
    expect(sep01.origin).toBe("predicted");
    expect(aug31.member).not.toBeNull();
    expect(sep01.member).not.toBeNull();
    // Consecutive picks over ana→bo→cy: whoever facilitates 08-31, the next
    // roster member facilitates 09-01 (the seam has no discontinuity).
    const order = R.members.map((m) => m.id);
    const i = order.indexOf(aug31.member!.id);
    expect(sep01.member!.id).toBe(order[(i + 1) % order.length]);
  });

  it("viewing NEXT month renders its leading padding from August and all September days", () => {
    const cells = buildMonth(R, RECENT, [], new Set(), TODAY, TODAY_PICK, 2026, 9);
    // September 2026 has 30 days; the 1st and 30th are present and inMonth.
    expect(cellFor(cells, "2026-09-01").inMonth).toBe(true);
    expect(cellFor(cells, "2026-09-30").inMonth).toBe(true);
    // Leading padding days (late August) are inMonth:false.
    const aug31 = cells.find((c) => c.date === "2026-08-31");
    if (aug31) expect(aug31.inMonth).toBe(false);
    // A whole-future month is entirely predicted or weekend — no history/today.
    for (const c of cells) {
      expect(c.origin === "history" || c.origin === "today").toBe(false);
    }
  });
});
