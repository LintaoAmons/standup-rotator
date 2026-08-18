// Configurable announcement time + send/rotation DECOUPLE (owner asks, 2026-08-18).
// The cron is a plain every-5-min heartbeat; each working-day tick advances the
// rotation, and — decoupled from that — the SEND fires once per (date, configured
// time) SLOT, reckoned in SGT. Editing the time mints a new slot and re-arms the
// send the same day ("每次都发"). These pin the moving parts: the pure gate
// (shouldAnnounce/sendSlot), the input validator (isValidTime), and the extracted
// tick (runScheduledTick) against the in-memory repo — no Worker, no clock, no net.

import { beforeEach, describe, expect, it } from "vitest";
import { isValidTime, minuteOf, predict, sendSlot, shouldAnnounce } from "../src/domain";
import { runScheduledTick, runStandup } from "../src/service";
import { MemoryRepo } from "./memory-repo";

// Instants are written in UTC; SGT = UTC+8. 2026-07-21 is a Tuesday (a working
// day, matching the crud/service fixtures). SGT 09:00 on that day == UTC 01:00.
const AT_0900 = new Date("2026-07-21T01:00:00Z"); // SGT Tue 09:00
const AT_0859 = new Date("2026-07-21T00:59:00Z"); // SGT Tue 08:59
const AT_0905 = new Date("2026-07-21T01:05:00Z"); // SGT Tue 09:05
const AT_0910 = new Date("2026-07-21T01:10:00Z"); // SGT Tue 09:10
const AT_WED_0900 = new Date("2026-07-22T01:00:00Z"); // SGT Wed 09:00
const TUE = "2026-07-21";
const SLOT_TUE_0900 = "2026-07-21|09:00"; // the default slot for TUE

describe("minuteOf — SGT wall-clock HH:MM", () => {
  it("shifts UTC to SGT and reads HH:MM", () => {
    expect(minuteOf(AT_0900)).toBe("09:00");
    expect(minuteOf(AT_0859)).toBe("08:59");
    expect(minuteOf(new Date("2026-07-21T15:59:00Z"))).toBe("23:59"); // SGT Tue 23:59
  });
});

describe("isValidTime — strict zero-padded 24h HH:MM", () => {
  it("accepts valid times", () => {
    expect(isValidTime("00:00")).toBe(true);
    expect(isValidTime("09:00")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
  });
  it("rejects out-of-range, unpadded and empty input", () => {
    expect(isValidTime("25:00")).toBe(false); // hour > 23
    expect(isValidTime("12:60")).toBe(false); // minute > 59
    expect(isValidTime("9:00")).toBe(false); // not zero-padded → would sort wrong
    expect(isValidTime("")).toBe(false);
    expect(isValidTime("0900")).toBe(false);
    expect(isValidTime("09:00 ")).toBe(false);
  });
});

describe("sendSlot — the (date, time) idempotency key", () => {
  it("joins date and configured time", () => {
    expect(sendSlot(TUE, "09:00")).toBe(SLOT_TUE_0900);
    expect(sendSlot(TUE, "08:30")).toBe("2026-07-21|08:30");
  });
});

describe("shouldAnnounce — the SGT working-day + time + per-slot gate", () => {
  it("does not fire one minute early", () => {
    expect(shouldAnnounce("08:59", "09:00", TUE, "")).toBe(false);
  });
  it("fires exactly at the configured time", () => {
    expect(shouldAnnounce("09:00", "09:00", TUE, "")).toBe(true);
  });
  it("still fires late (catch-up), when this slot has not been sent", () => {
    expect(shouldAnnounce("09:05", "09:00", TUE, "")).toBe(true);
  });
  it("does not re-fire once THIS slot is sent (same config, no resend)", () => {
    expect(shouldAnnounce("09:05", "09:00", TUE, SLOT_TUE_0900)).toBe(false);
  });
  it("re-arms when the time is changed to a NEW value already past the clock", () => {
    // 09:00 was sent; master edits to 08:30 (already reached). New slot != last.
    expect(shouldAnnounce("09:05", "08:30", TUE, SLOT_TUE_0900)).toBe(true);
  });
  it("re-arms when the time is changed to a later value, but only once it is reached", () => {
    // 09:00 was sent; master edits to 09:30. Still closed at 09:05...
    expect(shouldAnnounce("09:05", "09:30", TUE, SLOT_TUE_0900)).toBe(false);
    // ...and opens once the clock reaches the new time.
    expect(shouldAnnounce("09:35", "09:30", TUE, SLOT_TUE_0900)).toBe(true);
  });
  it("fires again on a new day even though yesterday's slot was sent", () => {
    expect(shouldAnnounce("09:00", "09:00", "2026-07-22", SLOT_TUE_0900)).toBe(true);
  });
  it("never fires on a weekend (reckoned in SGT)", () => {
    expect(shouldAnnounce("09:00", "09:00", "2026-07-25", "")).toBe(false); // Saturday
    expect(shouldAnnounce("09:00", "09:00", "2026-07-26", "")).toBe(false); // Sunday
  });
});

// The reason the cron is daily (not UTC `1-5`): the gate reckons the day in SGT,
// so a tick fired on a UTC Sunday instant can correctly open on SGT Monday, and a
// tick on a UTC Friday-evening instant is correctly closed as SGT Saturday.
describe("shouldAnnounce — SGT/UTC weekday skew is handled by the gate", () => {
  it("opens for early SGT Monday even though the instant is a UTC Sunday", () => {
    // SGT Mon 2026-07-20 07:00 == UTC Sun 2026-07-19 23:00.
    const instant = new Date("2026-07-19T23:00:00Z");
    const day = "2026-07-20"; // Monday in SGT
    expect(minuteOf(instant)).toBe("07:00");
    expect(shouldAnnounce(minuteOf(instant), "07:00", day, "")).toBe(true);
  });
  it("stays closed for SGT Saturday even though the instant is a UTC Friday", () => {
    // UTC Fri 2026-07-24 20:00 == SGT Sat 2026-07-25 04:00.
    const day = "2026-07-25"; // Saturday in SGT
    expect(shouldAnnounce("04:00", "04:00", day, "")).toBe(false);
  });
});

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

describe("runScheduledTick — decoupled rotation + slot-gated send", () => {
  let repo: MemoryRepo;
  beforeEach(() => {
    repo = fixture(); // announceTime defaults to "09:00", lastSentSlot ""
  });

  it("before the send time: rotation still advances, but nothing is sent (decoupled)", async () => {
    const tick = await runScheduledTick(repo, AT_0859);
    expect(tick.fired).toBe(false); // send gate closed (08:59 < 09:00)
    expect(repo.records).toHaveLength(1); // ...yet the rotation ran anyway
    expect(repo.lastSentSlot).toBe(""); // no send stamped
  });

  it("fires at the default 09:00: records the pick and stamps the slot", async () => {
    const tick = await runScheduledTick(repo, AT_0900);
    expect(tick.fired).toBe(true);
    expect(tick.result?.member.id).toBe("ana");
    expect(repo.records).toHaveLength(1);
    expect(repo.lastSentSlot).toBe(SLOT_TUE_0900);
    // No webhook configured → announced silently, no error.
    expect(tick.notifyError).toBeUndefined();
  });

  it("late catch-up fires once, then a later tick with the same config does not re-send", async () => {
    const first = await runScheduledTick(repo, AT_0905);
    expect(first.fired).toBe(true);
    const second = await runScheduledTick(repo, AT_0910);
    expect(second.fired).toBe(false); // same slot closes the gate
    expect(repo.records).toHaveLength(1);
  });

  it("respects a portal-changed time: 08:30 fires at 08:59, before the old 09:00", async () => {
    await repo.setAnnounceTime("08:30");
    const tick = await runScheduledTick(repo, AT_0859);
    expect(tick.fired).toBe(true);
    expect(repo.lastSentSlot).toBe("2026-07-21|08:30");
  });

  it("re-arms on a same-day time change: sends at 09:00, then a new time fires again", async () => {
    const first = await runScheduledTick(repo, AT_0900); // sent at 09:00
    expect(first.fired).toBe(true);
    expect(repo.lastSentSlot).toBe(SLOT_TUE_0900);
    // master edits the time to 09:05 (already reached) → next tick re-arms.
    await repo.setAnnounceTime("09:05");
    const second = await runScheduledTick(repo, AT_0910);
    expect(second.fired).toBe(true); // "每次都发" — a second send the same day
    expect(repo.lastSentSlot).toBe("2026-07-21|09:05");
    // A third identical tick does not re-send (config unchanged since).
    const third = await runScheduledTick(repo, AT_0910);
    expect(third.fired).toBe(false);
  });

  it("the send is a pure projection: it never advances rotation, even on a re-armed re-send", async () => {
    // Pin rotation state first (a pick exists for today).
    const before = await runStandup(repo, TUE, false);
    const orderBefore = (await repo.roster()).members.map((m) => m.id);
    const predBefore = predict(
      await repo.roster(),
      await repo.recent(50),
      await repo.leaves(),
      TUE,
      3,
    ).map((p) => p.member?.id);

    const assertRotationUnchanged = async (who: string) => {
      expect(repo.records).toHaveLength(1); // still one authoritative row
      expect((await repo.on(TUE))?.memberId).toBe(who); // same person, not rerolled
      expect((await repo.roster()).members.map((m) => m.id)).toEqual(orderBefore);
      const predNow = predict(
        await repo.roster(),
        await repo.recent(50),
        await repo.leaves(),
        TUE,
        3,
      ).map((p) => p.member?.id);
      expect(predNow).toEqual(predBefore);
    };

    // First send.
    const s1 = await runScheduledTick(repo, AT_0900);
    expect(s1.fired).toBe(true);
    expect(s1.result?.member.id).toBe(before.member.id);
    await assertRotationUnchanged(before.member.id);

    // Re-arm and send again the same day — rotation is STILL byte-for-byte the same.
    await repo.setAnnounceTime("09:05");
    const s2 = await runScheduledTick(repo, AT_0910);
    expect(s2.fired).toBe(true);
    await assertRotationUnchanged(before.member.id);
  });

  it("renews across days: yesterday's slot does not suppress today", async () => {
    await runScheduledTick(repo, AT_0900); // TUE sent
    expect(repo.lastSentSlot).toBe(SLOT_TUE_0900);
    const tick = await runScheduledTick(repo, AT_WED_0900); // next working day
    expect(tick.fired).toBe(true);
    expect(repo.lastSentSlot).toBe("2026-07-22|09:00");
    expect(repo.records).toHaveLength(2); // one authoritative pick per day
  });

  it("broadcasts even when a pick already exists (pick history != sent)", async () => {
    // A pick created early (e.g. GET /today) must NOT suppress the send: the tick
    // still opens the slot gate and stamps it.
    await runStandup(repo, TUE, false); // pre-existing pick, fresh
    const tick = await runScheduledTick(repo, AT_0900);
    expect(tick.fired).toBe(true);
    expect(tick.result?.fresh).toBe(false); // the pick was a replay...
    expect(repo.lastSentSlot).toBe(SLOT_TUE_0900); // ...but the send still fired once
  });

  it("does not fire on a weekend even past the time — no rotation, no send", async () => {
    // SGT Sat 2026-07-25 09:00 == UTC 01:00 that day.
    const tick = await runScheduledTick(repo, new Date("2026-07-25T01:00:00Z"));
    expect(tick.fired).toBe(false);
    expect(repo.records).toHaveLength(0); // weekend advances no rotation either
    expect(repo.lastSentSlot).toBe("");
  });
});
