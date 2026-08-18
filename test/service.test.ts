// Ports the Go service_test.go orchestration cases, adapted to the D1 model:
// history.date is UNIQUE, so a reroll UPSERTS the day's row instead of appending
// a second one. The behavioural intent (idempotency, force advances, history
// committed before notify) is unchanged from the Go version.

import { beforeEach, describe, expect, it } from "vitest";
import type { Facilitation, Member } from "../src/domain";
import { predict } from "../src/domain";
import { runStandup, skipStandup } from "../src/service";
import { MemoryRepo } from "./memory-repo";

const DAY = "2026-07-21";

function fixture(): MemoryRepo {
  const repo = new MemoryRepo();
  repo.r = {
    members: [
      { id: "ana", name: "Ana", handle: "" },
      { id: "bo", name: "Bo", handle: "" },
      { id: "cy", name: "Cy", handle: "" },
    ],
  };
  return repo;
}

// A notify spy that records what it was asked to announce and can fail on demand.
function spy() {
  const sent: Facilitation[] = [];
  let err: Error | null = null;
  const notify = async (f: Facilitation, _m: Member) => {
    if (err) throw err;
    sent.push(f);
  };
  return {
    notify,
    sent,
    fail: (e: Error) => {
      err = e;
    },
    ok: () => {
      err = null;
    },
  };
}

describe("runStandup", () => {
  let repo: MemoryRepo;
  beforeEach(() => {
    repo = fixture();
  });

  it("first run picks ana, records and announces once", async () => {
    const s = spy();
    const got = await runStandup(repo, DAY, false, s.notify);
    expect(got.member.id).toBe("ana");
    expect(got.fresh).toBe(true);
    expect(repo.records).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
  });

  it("same-day re-run is idempotent: no re-pick, no re-announce", async () => {
    const s = spy();
    const first = await runStandup(repo, DAY, false, s.notify);
    const second = await runStandup(repo, DAY, false, s.notify);
    expect(second.member.id).toBe(first.member.id);
    expect(second.fresh).toBe(false);
    expect(repo.records).toHaveLength(1);
    expect(s.sent).toHaveLength(1); // the replay did not re-announce
  });

  it("force rerolls: advances to bo and replaces the day's row (UNIQUE date)", async () => {
    await runStandup(repo, DAY, false);
    const forced = await runStandup(repo, DAY, true);
    expect(forced.member.id).toBe("bo");
    expect(forced.fresh).toBe(true);
    // Go appended a second row; UNIQUE(date) upserts to one authoritative row.
    expect(repo.records).toHaveLength(1);
    expect(await repo.on(DAY)).toEqual({ date: DAY, memberId: "bo" });
  });

  it("notify failure still commits history and the rotation advances", async () => {
    const s = spy();
    s.fail(new Error("chat is down"));
    const result = await runStandup(repo, DAY, false, s.notify);

    // The pick is committed and returned alongside the delivery failure.
    expect(result.member.id).toBe("ana");
    expect(result.notifyError).toBe("chat is down");
    expect(repo.records).toHaveLength(1);

    // Tomorrow genuinely advances to bo — not a repeat of the undelivered pick.
    s.ok();
    const next = await runStandup(repo, "2026-07-22", false, s.notify);
    expect(next.member.id).toBe("bo");
  });

  it("skips a member on leave", async () => {
    repo.l = [{ memberId: "ana", from: DAY, to: DAY }];
    const got = await runStandup(repo, DAY, false);
    expect(got.member.id).toBe("bo");
  });

  it("everyone on leave errors and leaves no trace", async () => {
    repo.l = [
      { memberId: "ana", from: DAY, to: DAY },
      { memberId: "bo", from: DAY, to: DAY },
      { memberId: "cy", from: DAY, to: DAY },
    ];
    await expect(runStandup(repo, DAY, false)).rejects.toThrow();
    expect(repo.records).toHaveLength(0);
  });

  it("a record failure must not announce", async () => {
    const s = spy();
    repo.recordErr = new Error("disk full");
    await expect(runStandup(repo, DAY, false, s.notify)).rejects.toThrow("disk full");
    expect(s.sent).toHaveLength(0);
  });

  it("idempotency is per date, not per wall clock", async () => {
    await runStandup(repo, DAY, false);
    await runStandup(repo, "2026-07-22", false);
    expect(repo.records).toHaveLength(2);
    const replay = await runStandup(repo, DAY, false);
    expect(replay.member.id).toBe("ana");
    expect(replay.fresh).toBe(false);
  });

  it("no webhook configured: run completes with no notify and no error", async () => {
    // notify undefined == the GOOGLE_CHAT_WEBHOOK-absent path.
    const got = await runStandup(repo, DAY, false, undefined);
    expect(got.member.id).toBe("ana");
    expect(got.notifyError).toBeUndefined();
    expect(got.fresh).toBe(true);
  });
});

// skipStandup — owner rule changed 2026-08-18. Old behaviour: the skipped person
// sank to the back of the cycle (an emergent property of history anchoring). New
// behaviour: they are requeued as NEXT (moved right behind the replacement), so
// tomorrow lands on them. These pin the new semantics — the ones that regress
// silently if the reorder step is dropped.
describe("skipStandup — the skipped person becomes next, not last", () => {
  let repo: MemoryRepo;
  beforeEach(() => {
    repo = fixture(); // [ana, bo, cy]
  });

  it("records the replacement for today and moves the skipped person behind them", async () => {
    await runStandup(repo, DAY, false); // ana picked for today
    const after = await skipStandup(repo, DAY);

    expect(after.member.id).toBe("bo"); // bo runs today in ana's place
    expect((await repo.on(DAY))?.memberId).toBe("bo"); // today's row is bo
    // ana requeued right behind bo — NOT sunk to the end.
    expect((await repo.roster()).members.map((m) => m.id)).toEqual(["bo", "ana", "cy"]);
  });

  it("tomorrow's pick is the skipped person (the whole point of the change)", async () => {
    await runStandup(repo, DAY, false); // ana today
    await skipStandup(repo, DAY); // bo today, ana requeued next

    const tomorrow = await runStandup(repo, "2026-07-22", false);
    expect(tomorrow.member.id).toBe("ana");
  });

  it("prediction reflects the skip immediately: the skipped person is first up", async () => {
    // DAY 2026-07-21 is a Tuesday; the next working day 07-22 is a Wednesday.
    await runStandup(repo, DAY, false); // ana today
    await skipStandup(repo, DAY); // bo today, ana requeued

    const recent = await repo.recent(50);
    const upcoming = predict(await repo.roster(), recent, await repo.leaves(), DAY, 3);
    expect(upcoming.map((p) => p.member?.id)).toEqual(["ana", "cy", "bo"]);
  });

  it("is a no-op reorder when the replacement equals the skipped person", async () => {
    // Single available member: everyone but ana is on leave, so the reroll
    // returns ana again and the order must not churn.
    repo.l = [
      { memberId: "bo", from: DAY, to: DAY },
      { memberId: "cy", from: DAY, to: DAY },
    ];
    await runStandup(repo, DAY, false); // ana
    const after = await skipStandup(repo, DAY);
    expect(after.member.id).toBe("ana");
    expect((await repo.roster()).members.map((m) => m.id)).toEqual(["ana", "bo", "cy"]);
  });
});

// The second skip kind — "pass" (skip·这轮直接过), added 2026-08-18. Same
// replacement-for-today as "requeue", but the rotation order is NOT mutated: the
// skipped person is not requeued and waits their natural turn. These pin the pass
// semantics AND the contrast against requeue, so collapsing the two modes back
// into one regresses a red test rather than silently.
describe("skipStandup mode 'pass' — order untouched, skipped person waits", () => {
  let repo: MemoryRepo;
  beforeEach(() => {
    repo = fixture(); // [ana, bo, cy]
  });

  it("records the replacement for today but leaves the rotation order unchanged", async () => {
    await runStandup(repo, DAY, false); // ana picked for today
    const after = await skipStandup(repo, DAY, "pass");

    expect(after.member.id).toBe("bo"); // bo runs today in ana's place
    expect((await repo.on(DAY))?.memberId).toBe("bo"); // today's row is bo
    // Order is exactly as seeded — ana is NOT bumped to the front.
    expect((await repo.roster()).members.map((m) => m.id)).toEqual(["ana", "bo", "cy"]);
  });

  it("tomorrow continues from the replacement (cy), not the skipped person", async () => {
    await runStandup(repo, DAY, false); // ana today
    await skipStandup(repo, DAY, "pass"); // bo today, order unchanged

    const tomorrow = await runStandup(repo, "2026-07-22", false);
    expect(tomorrow.member.id).toBe("cy"); // natural next after bo — ana waits
  });

  it("prediction continues from the replacement: cy, ana, bo", async () => {
    await runStandup(repo, DAY, false); // ana today
    await skipStandup(repo, DAY, "pass"); // bo today, order unchanged

    const recent = await repo.recent(50);
    const upcoming = predict(await repo.roster(), recent, await repo.leaves(), DAY, 3);
    expect(upcoming.map((p) => p.member?.id)).toEqual(["cy", "ana", "bo"]);
  });

  it("does not break same-day idempotency: a plain re-run replays the replacement", async () => {
    await runStandup(repo, DAY, false); // ana
    await skipStandup(repo, DAY, "pass"); // bo recorded for today
    const replay = await runStandup(repo, DAY, false);
    expect(replay.member.id).toBe("bo");
    expect(replay.fresh).toBe(false); // no re-pick
    expect(repo.records).toHaveLength(1); // one authoritative row for the day
  });
});

// The head-to-head the owner asked for: press each skip kind ONCE on the same
// starting state and assert the divergence. Both put bo on today; the ONLY
// difference is who comes next — requeue brings the skipped ana back tomorrow,
// pass lets the rotation roll on to cy while ana waits her natural turn.
describe("skip requeue vs pass — same day, one press each, contrasted", () => {
  async function run(mode: "requeue" | "pass") {
    const repo = fixture(); // [ana, bo, cy]
    await runStandup(repo, DAY, false); // ana today
    await skipStandup(repo, DAY, mode); // bo today either way
    const order = (await repo.roster()).members.map((m) => m.id);
    const tomorrow = (await runStandup(repo, "2026-07-22", false)).member.id;
    return { order, tomorrow };
  }

  it("requeue bumps ana to the front and to tomorrow", async () => {
    expect(await run("requeue")).toEqual({ order: ["bo", "ana", "cy"], tomorrow: "ana" });
  });

  it("pass keeps the order and rolls on to cy; ana waits", async () => {
    expect(await run("pass")).toEqual({ order: ["ana", "bo", "cy"], tomorrow: "cy" });
  });
});
