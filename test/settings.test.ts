// The webhook moved from a Worker secret into D1 (portal-editable). These pin the
// two behaviours the brief calls out: (1) what the settings page stores is read
// back verbatim, and (2) the scheduled path's send/skip decision follows the
// stored value — non-empty picks the send branch, empty (the default) skips
// without error, exactly as the old GOOGLE_CHAT_WEBHOOK-absent path did.

import { describe, expect, it } from "vitest";
import { chatNotifier } from "../src/notify";
import { MemoryRepo } from "./memory-repo";

describe("webhook settings (D1 singleton)", () => {
  it("defaults to empty and round-trips what the portal stores", async () => {
    const repo = new MemoryRepo();
    expect(await repo.getWebhook()).toBe("");

    const url = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=abc&token=xyz";
    await repo.setWebhook(url);
    expect(await repo.getWebhook()).toBe(url);

    // Clearing it turns announcements back off — same as never setting it.
    await repo.setWebhook("");
    expect(await repo.getWebhook()).toBe("");
  });

  it("scheduled decision: stored webhook -> send branch; empty -> skip", async () => {
    const repo = new MemoryRepo();

    // Empty -> chatNotifier yields undefined -> runStandup announces nothing.
    expect(chatNotifier(await repo.getWebhook())).toBeUndefined();

    // Non-empty -> a real notifier callback exists (the send branch).
    await repo.setWebhook("https://chat.googleapis.com/v1/spaces/AAA/messages?key=k");
    expect(typeof chatNotifier(await repo.getWebhook())).toBe("function");
  });
});
