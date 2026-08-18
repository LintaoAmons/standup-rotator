// Google Chat announcement channel.
//
// Deliberately optional: chatNotifier returns undefined when the webhook secret
// is absent, and runStandup then simply skips notification. This is what makes
// the whole product deployable before the webhook exists — the mandated
// "GOOGLE_CHAT_WEBHOOK secret exists ? send : skip, never error" behaviour.

import type { Facilitation, Member } from "./domain";
import type { Notify } from "./service";

// chatNotifier builds a notifier that POSTs to a Google Chat incoming webhook,
// or undefined when no webhook is configured. Undefined -> runStandup announces
// nothing and reports no error.
export function chatNotifier(webhook: string | undefined): Notify | undefined {
  if (!webhook || webhook.trim() === "") return undefined;

  return async (f: Facilitation, m: Member) => {
    const name = m.name || m.id;
    // Mention the handle when we have one; Google Chat renders <users/ID> as a
    // real mention, and falls back to the plain name otherwise.
    const who = m.handle ? `<users/${m.handle}> (${name})` : name;
    const text = `📅 Standup ${f.date} — facilitator: ${who}`;

    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`google chat webhook returned ${res.status}`);
    }
  };
}
