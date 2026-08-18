// CRUD over roster and leave, plus the domain invariant the brief calls out:
// editing the roster must NOT break next()/idempotency. The load-bearing case is
// deleting the person already picked for today — history stays truthful and the
// same-day replay is unchanged, while the next day advances past the gap.

import { beforeEach, describe, expect, it } from "vitest";
import { moveInOrder } from "../src/domain";
import { MemberExistsError } from "../src/repo";
import { runStandup } from "../src/service";
import { MemoryRepo } from "./memory-repo";

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

describe("moveInOrder — pure reorder rule", () => {
  it("moves a member later", () => {
    expect(moveInOrder(["ana", "bo", "cy"], "ana", 1)).toEqual(["bo", "ana", "cy"]);
  });
  it("moves a member earlier", () => {
    expect(moveInOrder(["ana", "bo", "cy"], "cy", -1)).toEqual(["ana", "cy", "bo"]);
  });
  it("is a no-op at the top boundary", () => {
    expect(moveInOrder(["ana", "bo"], "ana", -1)).toEqual(["ana", "bo"]);
  });
  it("is a no-op at the bottom boundary", () => {
    expect(moveInOrder(["ana", "bo"], "bo", 1)).toEqual(["ana", "bo"]);
  });
  it("is a no-op for an unknown id", () => {
    expect(moveInOrder(["ana", "bo"], "zz", 1)).toEqual(["ana", "bo"]);
  });
  it("returns a fresh array, not the input", () => {
    const input = ["ana", "bo"];
    expect(moveInOrder(input, "ana", -1)).not.toBe(input);
  });
});

describe("member CRUD", () => {
  let repo: MemoryRepo;
  beforeEach(() => (repo = fixture()));

  it("addMember appends at the end of the rotation", async () => {
    await repo.addMember({ id: "dee", name: "Dee", handle: "@dee" });
    expect((await repo.roster()).members.map((m) => m.id)).toEqual(["ana", "bo", "cy", "dee"]);
  });

  it("addMember rejects a duplicate id (identity is stable)", async () => {
    await expect(repo.addMember({ id: "ana", name: "Other", handle: "" })).rejects.toBeInstanceOf(
      MemberExistsError,
    );
  });

  it("renameMember changes display only; id is untouched", async () => {
    await repo.renameMember("ana", "Ana Silva", "@ana");
    const m = (await repo.roster()).members.find((x) => x.id === "ana")!;
    expect(m).toEqual({ id: "ana", name: "Ana Silva", handle: "@ana" });
  });

  it("setOrder persists a new rotation order", async () => {
    await repo.setOrder(["cy", "ana", "bo"]);
    expect((await repo.roster()).members.map((m) => m.id)).toEqual(["cy", "ana", "bo"]);
  });

  it("deleteMember drops the roster row and that member's leave", async () => {
    await repo.addLeave({ memberId: "bo", from: "2026-07-22", to: "2026-07-24" });
    await repo.deleteMember("bo");
    expect((await repo.roster()).members.map((m) => m.id)).toEqual(["ana", "cy"]);
    expect(await repo.leaves()).toEqual([]);
  });
});

describe("leave CRUD", () => {
  let repo: MemoryRepo;
  beforeEach(() => (repo = fixture()));

  it("addLeave then deleteLeave by (memberId, from, to)", async () => {
    await repo.addLeave({ memberId: "bo", from: "2026-07-22", to: "2026-07-24" });
    expect(await repo.leaves()).toHaveLength(1);
    await repo.deleteLeave({ memberId: "bo", from: "2026-07-22", to: "2026-07-24" });
    expect(await repo.leaves()).toEqual([]);
  });

  it("deleteLeave leaves other intervals of the same member intact", async () => {
    await repo.addLeave({ memberId: "bo", from: "2026-07-22", to: "2026-07-24" });
    await repo.addLeave({ memberId: "bo", from: "2026-08-01", to: "2026-08-02" });
    await repo.deleteLeave({ memberId: "bo", from: "2026-07-22", to: "2026-07-24" });
    expect(await repo.leaves()).toEqual([{ memberId: "bo", from: "2026-08-01", to: "2026-08-02" }]);
  });
});

// The invariant the brief singles out: editing the roster must not corrupt the
// rotation. history is the source of truth for "who went"; CRUD touches roster
// and leave only, so these hold by construction — but they are the cases a
// regression would break silently, so they are pinned.
describe("editing the roster preserves next()/idempotency", () => {
  const DAY = "2026-07-21";
  const NEXT = "2026-07-22";

  it("deleting today's already-picked member keeps the day's pick and advances tomorrow", async () => {
    const repo = fixture();

    // Today ana is picked and recorded.
    const t = await runStandup(repo, DAY, false);
    expect(t.member.id).toBe("ana");

    // ana is removed from the roster AFTER being picked today.
    await repo.deleteMember("ana");

    // Idempotency: today's replay still returns the recorded pick. The member is
    // no longer rostered, so she is reported by id — history stays truthful about
    // who actually facilitated, and no re-pick happens.
    const replay = await runStandup(repo, DAY, false);
    expect(replay.fresh).toBe(false);
    expect(replay.facilitation.memberId).toBe("ana");
    expect(replay.member).toEqual({ id: "ana", name: "ana", handle: "" });

    // Tomorrow advances past the departed facilitator to the next still-rostered
    // member (bo), never restarting at the top.
    const tomorrow = await runStandup(repo, NEXT, false);
    expect(tomorrow.member.id).toBe("bo");
  });

  it("adding a member does not disturb an already-recorded day", async () => {
    const repo = fixture();
    await runStandup(repo, DAY, false); // ana
    await repo.addMember({ id: "dee", name: "Dee", handle: "" });
    const replay = await runStandup(repo, DAY, false);
    expect(replay.fresh).toBe(false);
    expect(replay.member.id).toBe("ana");
  });

  it("reordering changes only future picks, not the recorded one", async () => {
    const repo = fixture();
    await runStandup(repo, DAY, false); // ana recorded for DAY

    // Reorder so cy leads. The recorded day is unchanged; tomorrow follows the
    // history anchor (ana) in the NEW order → the member after ana is bo... but
    // after reorder [cy, ana, bo], the member after ana is bo.
    await repo.setOrder(["cy", "ana", "bo"]);
    const replay = await runStandup(repo, DAY, false);
    expect(replay.member.id).toBe("ana"); // recorded pick untouched

    const tomorrow = await runStandup(repo, NEXT, false);
    expect(tomorrow.member.id).toBe("bo"); // anchor ana → next in new order is bo
  });
});
