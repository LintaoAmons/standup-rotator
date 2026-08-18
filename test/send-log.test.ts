// Sent history (owner ask, 7th round, 2026-08-18). Every REAL webhook delivery —
// the daily auto broadcast and the manual Announce button — records one send_log
// row for its outcome, SUCCESS OR FAILURE, because a failed send is the half the
// owner wants to see. A send that never happens (no webhook configured) logs
// nothing. These pin: (1) the shared send-and-record step announceAndLog for both
// outcomes and both trigger kinds; (2) the scheduled tick wiring, including that a
// missing webhook writes no row; (3) the UTC->SGT display; (4) newest-first order.

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSgt } from "../src/domain";
import { announceAndLog, runScheduledTick, type Notify } from "../src/service";
import { MemoryRepo } from "./memory-repo";

const F = { date: "2026-07-21", memberId: "ana" };
const ANA = { id: "ana", name: "Ana", handle: "" };
// SGT Tue 2026-07-21 09:00 == UTC 01:00 (SGT = UTC+8, no DST).
const AT = new Date("2026-07-21T01:00:00Z");

const ok: Notify = async () => {}; // delivery succeeds
const boom: Notify = async () => {
  throw new Error("google chat webhook returned 500");
};

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

describe("announceAndLog — the shared send-and-record step", () => {
  it("logs a 'sent' row on success, with the given trigger and SGT-storable UTC time", async () => {
    const repo = new MemoryRepo();
    const err = await announceAndLog(repo, ok, F, ANA, "manual", AT);
    expect(err).toBeUndefined();
    expect(repo.sends).toHaveLength(1);
    expect(repo.sends[0]).toEqual({
      sentAt: "2026-07-21T01:00:00.000Z", // stored UTC
      memberId: "ana",
      memberName: "Ana",
      trigger: "manual",
      result: "sent",
      error: "",
    });
  });

  it("logs a 'failed' row WITH the short reason when delivery throws (the half master wants)", async () => {
    const repo = new MemoryRepo();
    const err = await announceAndLog(repo, boom, F, ANA, "auto", AT);
    expect(err).toBe("google chat webhook returned 500");
    expect(repo.sends).toHaveLength(1);
    expect(repo.sends[0]).toEqual({
      sentAt: "2026-07-21T01:00:00.000Z",
      memberId: "ana",
      memberName: "Ana",
      trigger: "auto",
      result: "failed",
      error: "google chat webhook returned 500",
    });
  });

  it("distinguishes trigger method: auto vs manual land on their own rows", async () => {
    const repo = new MemoryRepo();
    await announceAndLog(repo, ok, F, ANA, "auto", AT);
    await announceAndLog(repo, ok, F, ANA, "manual", AT);
    expect(repo.sends.map((s) => s.trigger)).toEqual(["auto", "manual"]);
  });

  it("logs a departed member by id when the name is blank", async () => {
    const repo = new MemoryRepo();
    await announceAndLog(repo, ok, F, { id: "ghost", name: "", handle: "" }, "auto", AT);
    expect(repo.sends[0].memberName).toBe("ghost");
  });
});

describe("runScheduledTick — auto path logs one row per real delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("no webhook configured: the daily pick is recorded but NOTHING is logged (skip != send)", async () => {
    const repo = fixture(); // webhook "" by default
    const tick = await runScheduledTick(repo, AT);
    expect(tick.fired).toBe(true);
    expect(repo.records).toHaveLength(1); // pick still recorded
    expect(repo.sends).toHaveLength(0); // but no delivery -> no send_log row
  });

  it("webhook configured, delivery ok: logs one 'auto' 'sent' row", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    const repo = fixture();
    await repo.setWebhook("https://chat.googleapis.com/v1/spaces/AAA/messages?key=k");
    const tick = await runScheduledTick(repo, AT);
    expect(tick.fired).toBe(true);
    expect(tick.notifyError).toBeUndefined();
    expect(repo.sends).toHaveLength(1);
    expect(repo.sends[0].trigger).toBe("auto");
    expect(repo.sends[0].result).toBe("sent");
    expect(repo.sends[0].memberName).toBe("Ana");
  });

  it("webhook configured, delivery fails: logs one 'auto' 'failed' row with the reason", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    const repo = fixture();
    await repo.setWebhook("https://chat.googleapis.com/v1/spaces/AAA/messages?key=k");
    const tick = await runScheduledTick(repo, AT);
    expect(tick.fired).toBe(true);
    expect(tick.notifyError).toBe("google chat webhook returned 500");
    expect(repo.sends).toHaveLength(1);
    expect(repo.sends[0].result).toBe("failed");
    expect(repo.sends[0].error).toBe("google chat webhook returned 500");
  });
});

describe("formatSgt — UTC stored, SGT displayed", () => {
  it("shifts a stored UTC instant to the SGT wall clock", () => {
    // UTC 01:00 -> SGT 09:00; the date is unchanged here.
    expect(formatSgt("2026-07-21T01:00:00.000Z")).toBe("2026-07-21 09:00");
  });
  it("rolls the displayed date forward when +8 crosses midnight", () => {
    // UTC 2026-07-21 20:30 -> SGT 2026-07-22 04:30.
    expect(formatSgt("2026-07-21T20:30:00.000Z")).toBe("2026-07-22 04:30");
  });
});

describe("recentSends — newest first, capped", () => {
  it("returns rows newest-first and honours the limit", async () => {
    const repo = new MemoryRepo();
    // Insert oldest -> newest by timestamp.
    for (let h = 0; h < 25; h++) {
      const iso = `2026-07-21T${String(h % 24).padStart(2, "0")}:00:00.000Z`;
      await repo.logSend({
        sentAt: iso,
        memberId: "ana",
        memberName: "Ana",
        trigger: "auto",
        result: "sent",
        error: "",
      });
    }
    const last20 = await repo.recentSends(20);
    expect(last20).toHaveLength(20);
    // Newest first: the last inserted (hour 24%24=00 -> "00:00" on day 21... note
    // wrap) — assert strict descending order by sentAt instead of a single value.
    for (let i = 1; i < last20.length; i++) {
      expect(last20[i - 1].sentAt >= last20[i].sentAt).toBe(true);
    }
  });
});
