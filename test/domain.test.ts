// Ports every rotation edge case from the original Go rotation_test.go and the
// README's rules table. These are the "①单测覆盖旧 README 全部轮值边界 case" cases.

import { describe, expect, it } from "vitest";
import {
  addDays,
  AllOnLeaveError,
  covers,
  dayOf,
  EmptyRosterError,
  isWorkingDay,
  moveAfter,
  next,
  predict,
  unavailable,
  type Facilitation,
  type Roster,
} from "../src/domain";

function roster(...ids: string[]): Roster {
  return { members: ids.map((id) => ({ id, name: id, handle: "" })) };
}

// history builds a newest-first log from ids given oldest-first (how a human
// reads a rotation).
function history(...ids: string[]): Facilitation[] {
  const out: Facilitation[] = [];
  const base = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01
  ids.forEach((id, i) => {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    out.unshift({ date: d.toISOString().slice(0, 10), memberId: id });
  });
  return out;
}

function outSet(...ids: string[]): Set<string> {
  return new Set(ids);
}

describe("next — rotation rules", () => {
  it("no history yet picks the first roster member", () => {
    expect(next(roster("ana", "bo", "cy"), history(), outSet()).id).toBe("ana");
  });

  it("advances from the last facilitator", () => {
    expect(next(roster("ana", "bo", "cy"), history("ana"), outSet()).id).toBe("bo");
  });

  it("wraps around the end of the roster", () => {
    expect(next(roster("ana", "bo", "cy"), history("ana", "bo", "cy"), outSet()).id).toBe("ana");
  });

  it("skips a member on leave", () => {
    expect(next(roster("ana", "bo", "cy"), history("ana"), outSet("bo")).id).toBe("cy");
  });

  it("departed last facilitator resumes from their old position", () => {
    // bo has left the team; fall back to ana (newest still-rostered) and take
    // the next after her. Restarting at the top would stall on ana.
    expect(next(roster("ana", "cy", "dee"), history("ana", "bo"), outSet()).id).toBe("cy");
  });

  it("history entirely departed falls back to the top", () => {
    expect(next(roster("cy", "dee"), history("ana", "bo"), outSet()).id).toBe("cy");
  });

  it("everyone on leave is an explicit error", () => {
    expect(() => next(roster("ana", "bo"), history("ana"), outSet("ana", "bo"))).toThrow(
      AllOnLeaveError,
    );
  });

  it("single-member roster repeats and that is legal", () => {
    expect(next(roster("ana"), history("ana"), outSet()).id).toBe("ana");
  });

  it("single-member roster on leave is an error", () => {
    expect(() => next(roster("ana"), history("ana"), outSet("ana"))).toThrow(AllOnLeaveError);
  });

  it("empty roster is an explicit error", () => {
    expect(() => next(roster(), history(), outSet())).toThrow(EmptyRosterError);
  });
});

describe("covers — leave interval is inclusive on both ends", () => {
  const leave = { memberId: "ana", from: "2026-07-10", to: "2026-07-12" };
  it("day before is not covered", () => expect(covers(leave, "2026-07-09")).toBe(false));
  it("first day is inclusive", () => expect(covers(leave, "2026-07-10")).toBe(true));
  it("middle is covered", () => expect(covers(leave, "2026-07-11")).toBe(true));
  it("last day is inclusive", () => expect(covers(leave, "2026-07-12")).toBe(true));
  it("day after is not covered", () => expect(covers(leave, "2026-07-13")).toBe(false));
});

describe("dayOf — standup day is reckoned in Singapore time, not UTC", () => {
  // The bug this guards: CF cron fires in UTC, the team is in SGT (UTC+8). An
  // evening-UTC trigger is already the NEXT calendar day in Singapore, and a
  // UTC-based day would name yesterday's facilitator.
  it("an evening-UTC trigger yields the current SGT day, not the UTC day", () => {
    // 2026-08-17 23:00 UTC == 2026-08-18 07:00 SGT.
    expect(dayOf(new Date("2026-08-17T23:00:00Z"))).toBe("2026-08-18");
  });

  it("holds exactly at the SGT midnight boundary (16:00 UTC)", () => {
    // 15:59:59 UTC == 23:59:59 SGT of the 17th; 16:00:00 UTC == 00:00 SGT of the 18th.
    expect(dayOf(new Date("2026-08-17T15:59:59Z"))).toBe("2026-08-17");
    expect(dayOf(new Date("2026-08-17T16:00:00Z"))).toBe("2026-08-18");
  });

  it("a morning-UTC trigger stays on the same day", () => {
    // 01:00 UTC (the recommended 09:00 SGT cron) is well clear of the boundary.
    expect(dayOf(new Date("2026-08-18T01:00:00Z"))).toBe("2026-08-18");
  });
});

describe("unavailable — leaves reduced to a set for a date", () => {
  it("collects only members out on the date", () => {
    const leaves = [
      { memberId: "ana", from: "2026-07-10", to: "2026-07-12" },
      { memberId: "bo", from: "2026-07-20", to: "2026-07-24" },
    ];
    const out = unavailable(leaves, "2026-07-11");
    expect([...out]).toEqual(["ana"]);
  });
});

// moveAfter is the skip-requeue rule (owner 2026-08-18): the skipped person is
// moved to immediately behind their replacement, not sunk to the back. The
// load-bearing case is a non-adjacent move, where "insert after" differs from a
// plain swap.
describe("moveAfter — requeue skipped member behind the replacement", () => {
  it("moves an adjacent member (looks like a swap)", () => {
    expect(moveAfter(["ana", "bo", "cy", "dee"], "ana", "bo")).toEqual(["bo", "ana", "cy", "dee"]);
  });
  it("inserts (not swaps) when replacement is further along", () => {
    // ana skipped, cy took today (bo was on leave) -> ana sits right after cy.
    expect(moveAfter(["ana", "bo", "cy", "dee"], "ana", "cy")).toEqual(["bo", "cy", "ana", "dee"]);
  });
  it("moves a later member earlier, right after the anchor", () => {
    expect(moveAfter(["ana", "bo", "cy"], "cy", "ana")).toEqual(["ana", "cy", "bo"]);
  });
  it("is a no-op when moved === after", () => {
    expect(moveAfter(["ana", "bo"], "ana", "ana")).toEqual(["ana", "bo"]);
  });
  it("is a no-op when either id is absent", () => {
    expect(moveAfter(["ana", "bo"], "zz", "ana")).toEqual(["ana", "bo"]);
    expect(moveAfter(["ana", "bo"], "ana", "zz")).toEqual(["ana", "bo"]);
  });
  it("returns a fresh array, not the input", () => {
    const input = ["ana", "bo"];
    expect(moveAfter(input, "ana", "bo")).not.toBe(input);
  });
});

describe("isWorkingDay / addDays — calendar helpers for prediction", () => {
  it("Mon–Fri are working days, Sat/Sun are not", () => {
    expect(isWorkingDay("2026-08-21")).toBe(true); // Fri
    expect(isWorkingDay("2026-08-22")).toBe(false); // Sat
    expect(isWorkingDay("2026-08-23")).toBe(false); // Sun
    expect(isWorkingDay("2026-08-24")).toBe(true); // Mon
  });
  it("addDays advances the calendar date, crossing a month boundary", () => {
    expect(addDays("2026-08-21", 1)).toBe("2026-08-22");
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-08-24", 3)).toBe("2026-08-27");
  });
});

describe("predict — projected facilitators for the coming working days", () => {
  it("skips weekends and rotates from no history", () => {
    // From Fri 08-21: next 5 working days are Mon 08-24 .. Fri 08-28.
    const out = predict(roster("ana", "bo", "cy", "dee"), [], [], "2026-08-21", 5);
    expect(out.map((p) => p.date)).toEqual([
      "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28",
    ]);
    expect(out.map((p) => p.member?.id)).toEqual(["ana", "bo", "cy", "dee", "ana"]);
  });

  it("anchors on history: the projection starts after the last facilitator", () => {
    // ana went most recently -> tomorrow (Tue 08-18) starts at bo.
    const out = predict(roster("ana", "bo", "cy", "dee"), history("ana"), [], "2026-08-17", 3);
    expect(out.map((p) => p.member?.id)).toEqual(["bo", "cy", "dee"]);
  });

  it("steps over a member on leave on a projected day", () => {
    // bo is out on Tue 08-25 (the 2nd projected day) -> that slot goes to cy,
    // and bo does not consume a turn.
    const leaves = [{ memberId: "bo", from: "2026-08-25", to: "2026-08-25" }];
    const out = predict(roster("ana", "bo", "cy", "dee"), [], leaves, "2026-08-21", 3);
    // 08-24 ana, 08-25 (bo on leave -> cy), 08-26 (after cy -> dee)
    expect(out.map((p) => [p.date, p.member?.id])).toEqual([
      ["2026-08-24", "ana"],
      ["2026-08-25", "cy"],
      ["2026-08-26", "dee"],
    ]);
  });

  it("yields a null member on a day when everyone is on leave, without advancing", () => {
    const leaves = [
      { memberId: "ana", from: "2026-08-24", to: "2026-08-24" },
      { memberId: "bo", from: "2026-08-24", to: "2026-08-24" },
    ];
    const out = predict(roster("ana", "bo"), [], leaves, "2026-08-21", 2);
    expect(out[0]).toEqual({ date: "2026-08-24", member: null }); // Mon: all out
    expect(out[1].member?.id).toBe("ana"); // Tue: anchor unmoved -> top of roster
  });

  it("returns all-null for an empty roster", () => {
    const out = predict(roster(), [], [], "2026-08-21", 2);
    expect(out.every((p) => p.member === null)).toBe(true);
    expect(out).toHaveLength(2);
  });
});
