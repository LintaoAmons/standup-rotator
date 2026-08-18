// In-memory Repo for tests. The cheapest proof the port is honest: a port with
// exactly one implementation tends to quietly leak that implementation's
// assumptions. Mirrors the D1 semantics — recent() is newest-first, on() returns
// the day's row, record() upserts by date (history.date is UNIQUE).

import type { Facilitation, Leave, Member, Roster } from "../src/domain";
import { MemberExistsError, type Repo, type SendLogEntry } from "../src/repo";

export class MemoryRepo implements Repo {
  r: Roster = { members: [] };
  l: Leave[] = [];
  records: Facilitation[] = []; // oldest first, at most one row per date
  recordErr: Error | null = null;

  async roster(): Promise<Roster> {
    return this.r;
  }
  async leaves(): Promise<Leave[]> {
    return this.l;
  }
  async recent(limit: number): Promise<Facilitation[]> {
    // newest first, by date string (chronological) — matches ORDER BY date DESC.
    return [...this.records]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit);
  }
  async on(date: string): Promise<Facilitation | null> {
    return this.records.find((f) => f.date === date) ?? null;
  }
  async record(f: Facilitation): Promise<void> {
    if (this.recordErr) throw this.recordErr;
    const i = this.records.findIndex((r) => r.date === f.date);
    if (i >= 0) this.records[i] = f; // upsert: UNIQUE(date)
    else this.records.push(f);
  }

  // ---- CRUD — mirrors D1Repo semantics (see src/repo.ts) ----------------

  async addMember(m: Member): Promise<void> {
    if (this.r.members.some((x) => x.id === m.id)) throw new MemberExistsError(m.id);
    this.r.members.push({ ...m }); // append == last rotation position
  }
  async deleteMember(id: string): Promise<void> {
    this.r.members = this.r.members.filter((m) => m.id !== id);
    this.l = this.l.filter((x) => x.memberId !== id); // orphan leave goes too
  }
  async renameMember(id: string, name: string, handle: string): Promise<void> {
    const m = this.r.members.find((x) => x.id === id);
    if (m) {
      m.name = name;
      m.handle = handle;
    }
  }
  async setOrder(ids: string[]): Promise<void> {
    // Reorder existing members to match ids; unknown ids ignored, missing kept.
    const byId = new Map(this.r.members.map((m) => [m.id, m]));
    const ordered = ids.map((id) => byId.get(id)).filter((m): m is Member => !!m);
    const rest = this.r.members.filter((m) => !ids.includes(m.id));
    this.r.members = [...ordered, ...rest];
  }
  async addLeave(l: Leave): Promise<void> {
    this.l.push({ ...l });
  }
  async deleteLeave(l: Leave): Promise<void> {
    const i = this.l.findIndex(
      (x) => x.memberId === l.memberId && x.from === l.from && x.to === l.to,
    );
    if (i >= 0) this.l.splice(i, 1);
  }

  // the singleton settings row, in memory. announceTime defaults to "09:00" to
  // mirror the schema DEFAULT; lastSentSlot is "" until the first send.
  webhook = "";
  announceTime = "09:00";
  lastSentSlot = "";
  async getWebhook(): Promise<string> {
    return this.webhook;
  }
  async setWebhook(url: string): Promise<void> {
    this.webhook = url;
  }
  async getAnnounceTime(): Promise<string> {
    return this.announceTime;
  }
  async setAnnounceTime(hhmm: string): Promise<void> {
    this.announceTime = hhmm;
  }
  async getLastSentSlot(): Promise<string> {
    return this.lastSentSlot;
  }
  async setLastSentSlot(slot: string): Promise<void> {
    this.lastSentSlot = slot;
  }

  // send_log rows in insertion (chronological) order. recentSends returns them
  // newest first — reverse then stable-sort by sentAt DESC so that among rows
  // sharing a sentAt second the newest-inserted wins, matching D1's
  // `ORDER BY sent_at DESC, id DESC`.
  sends: SendLogEntry[] = [];
  async logSend(e: SendLogEntry): Promise<void> {
    this.sends.push({ ...e });
  }
  async recentSends(limit: number): Promise<SendLogEntry[]> {
    return [...this.sends]
      .reverse()
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0))
      .slice(0, limit);
  }
}
