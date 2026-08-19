// The Cloudflare Worker entry point: one fetch handler for the HTTP surface
// (read, skip, the login gate, and the roster/leave CRUD) plus one scheduled
// handler that the cron trigger drives. Both funnel the actual rotation through
// the same runStandup use case, so the triggers cannot drift apart.
//
// The password gate wraps the fetch surface only. scheduled() is invoked by the
// Cloudflare runtime directly (never through fetch), so the cron path is never
// gated — the mandated "unauthenticated blocks the web, cron keeps running".

import {
  buildMonth,
  dayOf,
  formatSgt,
  isValidTime,
  moveInOrder,
  nextNotification,
  predict,
  type Facilitation,
  type Leave,
  type Member,
  type MonthCell,
  type Prediction,
} from "./domain";
import {
  clearSessionCookie,
  isAuthed,
  sessionToken,
  setSessionCookie,
  verifyPassword,
} from "./auth";
import { chatNotifier } from "./notify";
import { D1Repo, MemberExistsError, type Repo } from "./repo";
import { announceAndLog, runScheduledTick, runStandup, skipStandup, type SkipMode } from "./service";

export interface Env {
  DB: D1Database;
  // The Google Chat webhook is NOT an env var / secret anymore — it lives in D1
  // (settings table) and is edited from the logged-in portal, so master can set
  // and rotate it with no wrangler access. scheduled() reads it via repo.getWebhook().
  // The single shared login password. Held ONLY as a secret
  // (`wrangler secret put APP_PASSWORD`), never in wrangler.jsonc or code. Absent
  // -> the gate fails closed: the login page renders but no password validates,
  // so the whole web surface stays locked (scheduled runs are unaffected).
  APP_PASSWORD?: string;
}

// today resolves the standup date. A ?date=YYYY-MM-DD override exists purely so
// the endpoints can be driven deterministically in local testing; production
// requests omit it and get the current standup day, reckoned in SGT (see dayOf).
function today(url: URL): string {
  const q = url.searchParams.get("date");
  if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  return dayOf(new Date());
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

// seeOther is the Post/Redirect/Get response after a mutation: the browser
// re-GETs the target, so a refresh never re-submits the form.
function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...headers } });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const repo: Repo = new D1Repo(env.DB);

    try {
      // ---- login gate: /login is the ONLY route reachable unauthenticated ----
      if (path === "/login" && req.method === "GET") {
        return html(renderLogin());
      }
      if (path === "/login" && req.method === "POST") {
        const form = await req.formData();
        const password = String(form.get("password") ?? "");
        if (await verifyPassword(env.APP_PASSWORD, password)) {
          const token = await sessionToken(env.APP_PASSWORD);
          return seeOther("/", { "Set-Cookie": setSessionCookie(token) });
        }
        // Failure says only "incorrect" — never which part was wrong (there is
        // only a password anyway; still, no oracle). 401, re-render the form.
        return html(renderLogin("Incorrect password."), 401);
      }

      // Everything past here requires a valid session. Unauthenticated requests
      // get NO content: the page redirects to /login, APIs get a bare 401.
      if (!(await isAuthed(req, env.APP_PASSWORD))) {
        if (req.method === "GET" && (path === "/" || path === "/today")) {
          // GET / redirects; GET /today is JSON so answer in kind — either way
          // the roster/pick is not disclosed.
          return path === "/" ? seeOther("/login") : json({ error: "unauthorized" }, 401);
        }
        return json({ error: "unauthorized" }, 401);
      }

      // ---- authenticated surface -------------------------------------------

      if (path === "/logout" && req.method === "POST") {
        return seeOther("/login", { "Set-Cookie": clearSessionCookie() });
      }

      // GET /today — ensure today has a pick and return it. Idempotent: repeated
      // calls return the same person (force=false hits the same-day check).
      if (path === "/today" && req.method === "GET") {
        return json(await runStandup(repo, today(url), false));
      }

      // POST /skip — the current facilitator steps aside. Ensure a pick exists and
      // reroll once past it. The ?mode form field picks between the two owner
      // skip kinds (2026-08-18): "requeue" bumps the skipped person to next
      // working day (order changes); "pass" leaves the order untouched so they
      // wait their natural turn. Default "requeue" preserves the prior single
      // button's behaviour. Not idempotent by design: each press advances.
      // Redirects back to / (Post/Redirect/Get) so the button is driven from the
      // page, not a JSON dead-end.
      if (path === "/skip" && req.method === "POST") {
        const form = await req.formData();
        const mode: SkipMode = String(form.get("mode") ?? "") === "pass" ? "pass" : "requeue";
        await skipStandup(repo, today(url), mode);
        return seeOther(mode === "pass" ? "/?flash=skipped-pass" : "/?flash=skipped");
      }

      // POST /trigger — announce TODAY's facilitator to Google Chat right now,
      // WITHOUT rotating (owner ask, 2026-08-18). Ensures today has a pick
      // (idempotent, never rerolls), then posts it directly — bypassing
      // runStandup's notify, which only fires on a fresh pick. When no webhook is
      // configured it does NOT silently no-op: it redirects with a visible hint
      // pointing at the settings field, so the button always gives feedback.
      if (path === "/trigger" && req.method === "POST") {
        const date = today(url);
        const cur = await runStandup(repo, date, false);
        const webhook = await repo.getWebhook();
        // No webhook -> nothing is POSTed, so nothing is logged (skip != send).
        if (!webhook) return seeOther("/?flash=webhook-missing");
        // Same send-and-record step the scheduled tick uses, tagged "manual", so
        // the Announce button and the auto broadcast log identically. Failures are
        // logged too (announceAndLog writes a row either way).
        const err = await announceAndLog(
          repo,
          chatNotifier(webhook)!,
          cur.facilitation,
          cur.member,
          "manual",
          new Date(),
        );
        return seeOther(err ? "/?flash=send-failed" : "/?flash=sent");
      }

      // ---- roster / leave CRUD (form POSTs from the page) -------------------
      if (req.method === "POST" && path.startsWith("/members/")) {
        return await handleMemberMutation(repo, path, await req.formData());
      }
      if (req.method === "POST" && path.startsWith("/leave/")) {
        return await handleLeaveMutation(repo, path, await req.formData());
      }

      // POST /settings/webhook — master pastes/clears the Google Chat webhook.
      // Stored trimmed in D1; blank == announcements off. No validation beyond
      // trim: a malformed URL simply fails delivery (swallowed as notifyError).
      if (path === "/settings/webhook" && req.method === "POST") {
        const form = await req.formData();
        await repo.setWebhook(String(form.get("webhook") ?? "").trim());
        return seeOther("/?flash=saved");
      }

      // POST /settings/time — master sets the daily announcement time (HH:MM in
      // SGT). Validated with isValidTime BEFORE storing: only compare-safe,
      // zero-padded 24h values reach D1, so the shouldAnnounce string compare
      // stays honest. Invalid input ("25:00", "") is refused with a visible flash
      // and nothing is written. Change takes effect on the next 5-min tick — no
      // redeploy, because the cron is high-frequency and the gate reads D1.
      if (path === "/settings/time" && req.method === "POST") {
        const form = await req.formData();
        const hhmm = String(form.get("time") ?? "").trim();
        if (!isValidTime(hhmm)) return seeOther("/?flash=bad-time");
        await repo.setAnnounceTime(hhmm);
        return seeOther("/?flash=time-saved");
      }

      // GET /calendar — the month view. Reads only; never triggers a pick. The
      // ?month=YYYY-MM query drives navigation; absent, it shows today's SGT month.
      if (path === "/calendar" && req.method === "GET") {
        return html(await renderCalendar(repo, today(url), url.searchParams.get("month")));
      }

      // GET / — the status + editing page. Reads only; never triggers a pick.
      if (path === "/" && req.method === "GET") {
        return html(await renderPage(repo, today(url), url.searchParams.get("flash")));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },

  // scheduled — the cron trigger, HIGH frequency (every 5 min, every day, see
  // wrangler.jsonc). The send decision is a RUNTIME gate because the announce time
  // is portal-configurable and Cloudflare cron is static at deploy time.
  // runScheduledTick advances the rotation every working-day tick and, decoupled,
  // broadcasts once per (date, configured-time) slot — so a time edit re-arms the
  // send the same day. Most ticks are a no-op send (fired=false). NOT gated by
  // APP_PASSWORD: the runtime invokes this directly, bypassing fetch. A delivery
  // failure is captured in tick.notifyError, never thrown. Any throw (e.g. empty
  // roster) is caught so one bad tick doesn't crash the invocation; the slot stays
  // unsent so the next tick retries once the roster is fixed.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const repo: Repo = new D1Repo(env.DB);
    try {
      const tick = await runScheduledTick(repo, new Date());
      if (!tick.fired) return; // weekend, before the configured time, or this slot already sent
      const f = tick.result!.facilitation;
      if (tick.notifyError) {
        console.error(`standup ${f.date}: notify failed: ${tick.notifyError}`);
      } else {
        console.log(`standup ${f.date}: announced ${tick.result!.member.name || f.memberId}`);
      }
    } catch (e) {
      console.error(`standup tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ---- CRUD handlers ---------------------------------------------------------
//
// Each returns a 303 back to / on success (Post/Redirect/Get) or a 400 on bad
// input. Validation is deliberately shallow — this is a trusted, single-password
// tool — but it does refuse the inputs that would corrupt the data model: blank
// ids/names, malformed dates, inverted leave intervals, unknown routes.

function bad(reason: string): Response {
  return new Response(`invalid input: ${reason}`, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handleMemberMutation(repo: Repo, path: string, form: FormData): Promise<Response> {
  const s = (k: string) => String(form.get(k) ?? "").trim();

  switch (path) {
    case "/members/add": {
      const id = s("id");
      const name = s("name");
      if (!id || !name) return bad("member id and name are required");
      try {
        await repo.addMember({ id, name, handle: s("handle") });
      } catch (e) {
        if (e instanceof MemberExistsError) return bad(e.message);
        throw e;
      }
      return seeOther("/");
    }
    case "/members/rename": {
      const id = s("id");
      const name = s("name");
      if (!id || !name) return bad("member id and name are required");
      await repo.renameMember(id, name, s("handle"));
      return seeOther("/?flash=saved");
    }
    case "/members/delete": {
      const id = s("id");
      if (!id) return bad("member id is required");
      await repo.deleteMember(id);
      return seeOther("/");
    }
    case "/members/move": {
      const id = s("id");
      const dir = s("dir");
      if (!id || (dir !== "up" && dir !== "down")) return bad("id and dir=up|down are required");
      // Compute the new order purely, then persist the whole ordering.
      const roster = await repo.roster();
      const order = moveInOrder(roster.members.map((m) => m.id), id, dir === "up" ? -1 : 1);
      await repo.setOrder(order);
      return seeOther("/");
    }
    default:
      return json({ error: "not found" }, 404);
  }
}

async function handleLeaveMutation(repo: Repo, path: string, form: FormData): Promise<Response> {
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const memberId = s("memberId");
  const from = s("from");
  const to = s("to");

  if (!memberId) return bad("memberId is required");
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return bad("from/to must be YYYY-MM-DD");
  if (from > to) return bad("from must be on or before to");
  const leave: Leave = { memberId, from, to };

  switch (path) {
    case "/leave/add":
      await repo.addLeave(leave);
      return seeOther("/");
    case "/leave/delete":
      await repo.deleteLeave(leave);
      return seeOther("/");
    default:
      return json({ error: "not found" }, 404);
  }
}

// ---- HTML rendering --------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Shared minimal styling — flat, thin-line, matches the project's design language.
const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 680px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  .today { font-size: 1.1rem; margin: 1rem 0 2rem; padding-bottom: 1rem; border-bottom: 1px solid #8884; }
  h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin-top: 2rem; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 0.4rem 0.5rem; border-bottom: 1px solid #8882; text-align: left; }
  th { font-size: 0.75rem; text-transform: uppercase; opacity: 0.5; font-weight: 600; }
  .num { opacity: 0.6; width: 2.5rem; }
  .empty { opacity: 0.5; }
  form.inline { display: inline; margin: 0; }
  input { font: inherit; padding: 0.25rem 0.4rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; }
  input[type=text] { width: 7rem; }
  button { font: inherit; padding: 0.25rem 0.5rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
  button:hover { border-color: currentColor; }
  .actions { white-space: nowrap; }
  .actions button { padding: 0.15rem 0.4rem; }
  .add-row td { padding-top: 0.6rem; }
  .topbar { display: flex; justify-content: space-between; align-items: baseline; }
  input.wide { width: 100%; box-sizing: border-box; max-width: 34rem; }
  .hint { font-size: 0.85rem; opacity: 0.55; margin: 0.4rem 0 0; }
  .tz { font-size: 0.85rem; opacity: 0.6; margin: 0 0.5rem; }
  .flash { margin: 1rem 0 0; padding: 0.5rem 0.75rem; border: 1px solid #8886; border-left-width: 3px; border-radius: 4px; font-size: 0.9rem; }
  .fail { color: #d33; }
`;

function renderLogin(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Standup Roster — Login</title>
<style>${STYLE}
  .login { max-width: 20rem; margin: 4rem auto; }
  .login input { width: 100%; box-sizing: border-box; margin: 0.5rem 0; }
  .login button { width: 100%; }
  .err { color: #d33; font-size: 0.9rem; }
</style>
</head>
<body>
  <div class="login">
    <h1>Standup Roster</h1>
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <form method="post" action="/login">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// flashText maps the one-shot ?flash= code (set by a mutation's redirect) to a
// user-facing banner line. A code the page does not know renders nothing, so a
// stray query param can never inject arbitrary text. Kept here beside renderPage
// because it is purely a rendering concern.
function flashText(code: string | null): string {
  switch (code) {
    case "saved": return "Saved.";
    case "time-saved": return "Announcement time saved — re-arms today's send; effective from the next scheduled check.";
    case "bad-time": return "Invalid time — use 24-hour HH:MM (e.g. 09:00). Nothing was changed.";
    case "skipped": return "Skipped — the skipped person moves to the next working day (see the queue below).";
    case "skipped-pass": return "Skipped for today — rotation order unchanged; the skipped person waits their natural turn (see the queue below).";
    case "sent": return "Announcement sent to Google Chat.";
    case "webhook-missing": return "No webhook configured — set the Google Chat webhook below first, then announce.";
    case "send-failed": return "Send failed — check the Google Chat webhook URL below.";
    default: return "";
  }
}

async function renderPage(repo: Repo, date: string, flash: string | null = null): Promise<string> {
  const roster = await repo.roster();
  const leaves = await repo.leaves();
  // recent feeds both the history panel (last 10 shown) and predict(), which
  // needs enough back-history to resume past any departed facilitators.
  const recent = await repo.recent(50);
  const todayPick: Facilitation | null = await repo.on(date);
  const webhook = await repo.getWebhook();
  const announceTime = await repo.getAnnounceTime();
  const lastSentSlot = await repo.getLastSentSlot();
  // Sent history: the last 20 real webhook deliveries, newest first. Read-only.
  const sends = await repo.recentSends(20);

  // Next-notification indicator (owner ask 2026-08-18). Computed server-side from
  // the real send semantics; the page's embedded JS only counts down to this
  // instant. Uses the actual wall clock (new Date()) — the ?date= override drives
  // the pick date in tests, not this real-time countdown. No webhook -> the pure
  // function returns "no-webhook" and the section says so instead of counting down
  // to a broadcast that cannot happen.
  const nextNoti = nextNotification(new Date(), announceTime, lastSentSlot, webhook !== "");
  const nextNotiSection =
    nextNoti.kind === "no-webhook"
      ? `<p class="hint">No upcoming notification — no Google Chat webhook configured. Set the webhook in the field above to enable the daily announcement.</p>`
      : `<p class="hint" id="next-noti" data-target="${nextNoti.at.getTime()}">Next notification in <span id="next-noti-eta">…</span> — ${esc(formatSgt(nextNoti.at.toISOString()))} SGT.</p>
  <p class="hint">The cron checks every 5 minutes, so the actual send lands within about 5 minutes of that time (±5 min).</p>
  <script>
  (function(){
    var el = document.getElementById('next-noti');
    if (!el) return;
    var eta = document.getElementById('next-noti-eta');
    var target = parseInt(el.getAttribute('data-target'), 10);
    function tick(){
      var diff = target - Date.now();
      if (diff <= 0) { eta.textContent = 'any moment now'; return; }
      var mins = Math.floor(diff / 60000);
      eta.textContent = Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
    }
    tick();
    setInterval(tick, 60000); // refresh the page after the time passes to roll to the next slot
  })();
  </script>`;

  // Project the next 5 working days from today. Pure projection over the current
  // roster/order/leave + recorded history; nothing is written.
  const upcoming: Prediction[] = predict(roster, recent, leaves, date, 5);

  const memberName = (id: string): string =>
    roster.members.find((m) => m.id === id)?.name ?? id;

  const flashMsg = flashText(flash);
  const flashBanner = flashMsg ? `<div class="flash">${esc(flashMsg)}</div>` : "";

  const rosterRows = roster.members
    .map((m: Member, i: number) => {
      const up = i > 0 ? `<button name="dir" value="up" title="Move up">↑</button>` : "";
      const down =
        i < roster.members.length - 1 ? `<button name="dir" value="down" title="Move down">↓</button>` : "";
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>
          <form class="inline" method="post" action="/members/rename">
            <input type="hidden" name="id" value="${esc(m.id)}">
            <input type="text" name="name" value="${esc(m.name)}" aria-label="name">
            <input type="text" name="handle" value="${esc(m.handle)}" placeholder="chat handle" aria-label="handle">
            <button type="submit">Save</button>
          </form>
        </td>
        <td class="num">${esc(m.id)}</td>
        <td class="actions">
          <form class="inline" method="post" action="/members/move">
            <input type="hidden" name="id" value="${esc(m.id)}">${up}${down}
          </form>
          <form class="inline" method="post" action="/members/delete">
            <input type="hidden" name="id" value="${esc(m.id)}">
            <button type="submit" title="Remove from roster">✕</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const historyRows = recent
    .slice(0, 10) // recent holds 50 for predict(); the panel shows the last 10
    .map((f) => `<tr><td>${esc(f.date)}</td><td>${esc(memberName(f.memberId))}</td></tr>`)
    .join("");

  // Next up: the projected facilitators for the coming working days. A null
  // member (empty roster / all on leave that day) renders as a dash.
  const upcomingRows = upcoming
    .map(
      (p) =>
        `<tr><td>${esc(p.date)}</td><td>${p.member ? esc(p.member.name || p.member.id) : '<span class="empty">—</span>'}</td></tr>`,
    )
    .join("");

  // Leave rows offer a delete; the (memberId, from, to) triple identifies the row.
  const leaveRows = leaves
    .map(
      (l: Leave) => `<tr>
        <td>${esc(memberName(l.memberId))}</td>
        <td>${esc(l.from)} → ${esc(l.to)}</td>
        <td class="actions">
          <form class="inline" method="post" action="/leave/delete">
            <input type="hidden" name="memberId" value="${esc(l.memberId)}">
            <input type="hidden" name="from" value="${esc(l.from)}">
            <input type="hidden" name="to" value="${esc(l.to)}">
            <button type="submit" title="Remove leave">✕</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  // <datalist> lets the leave form pick a member id without retyping it.
  const memberOptions = roster.members
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
    .join("");

  // Sent history rows: time in SGT, the snapshotted member name, how it was
  // triggered, and the outcome (a failure shows its short reason). member_name is
  // the snapshot from send time, so a since-renamed/deleted member still reads
  // truthfully here.
  const sendRows = sends
    .map((s) => {
      const how = s.trigger === "auto" ? "auto" : "manual";
      const outcome =
        s.result === "sent"
          ? "sent"
          : `<span class="fail">failed</span>${s.error ? " — " + esc(s.error) : ""}`;
      return `<tr>
        <td>${esc(formatSgt(s.sentAt))}</td>
        <td>${esc(s.memberName)}</td>
        <td>${how}</td>
        <td>${outcome}</td>
      </tr>`;
    })
    .join("");

  const todayLine = todayPick
    ? `<strong>${esc(memberName(todayPick.memberId))}</strong>`
    : `<em>not picked yet</em>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Standup Roster</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="topbar">
    <h1>Standup Roster</h1>
    <span><a href="/calendar">Calendar</a> &nbsp; <form class="inline" method="post" action="/logout"><button type="submit">Sign out</button></form></span>
  </div>
  ${flashBanner}
  <div class="today">Today (${esc(date)}): ${todayLine}
    <form class="inline" method="post" action="/skip">
      <button type="submit" name="mode" value="requeue" title="Skip today: the skipped person is bumped to the next working day (rotation order changes)">Skip (goes next)</button>
      <button type="submit" name="mode" value="pass" title="Skip today: the skipped person keeps their place and waits their natural turn (rotation order unchanged)">Skip (pass)</button>
    </form>
    <form class="inline" method="post" action="/trigger"><button type="submit" title="Announce today's facilitator to Google Chat now, without rotating">Announce</button></form>
  </div>

  <h2>Next up (predicted)</h2>
  <table>
    <tr><th>Date</th><th>Facilitator</th></tr>
    ${upcomingRows || '<tr><td class="empty" colspan="2">nothing to predict</td></tr>'}
  </table>
  <p class="hint">Projected from the current rotation, order and leave — not yet recorded. Either Skip updates this immediately: "goes next" puts the skipped person first here; "pass" leaves the order and continues from the replacement.</p>

  <h2>Rotation order</h2>
  <table>
    <tr><th class="num">#</th><th>Name / handle</th><th class="num">id</th><th></th></tr>
    ${rosterRows || '<tr><td class="empty" colspan="4">roster is empty</td></tr>'}
    <tr class="add-row">
      <td class="num">+</td>
      <td colspan="3">
        <form class="inline" method="post" action="/members/add">
          <input type="text" name="id" placeholder="id (e.g. ana)" required aria-label="new member id">
          <input type="text" name="name" placeholder="Name" required aria-label="new member name">
          <input type="text" name="handle" placeholder="chat handle" aria-label="new member handle">
          <button type="submit">Add member</button>
        </form>
      </td>
    </tr>
  </table>

  <h2>On leave</h2>
  <table>
    ${leaveRows || '<tr><td class="empty" colspan="3">nobody on leave</td></tr>'}
    <tr class="add-row">
      <td colspan="3">
        <form class="inline" method="post" action="/leave/add">
          <input type="text" name="memberId" list="member-ids" placeholder="member id" required aria-label="leave member id">
          <input type="date" name="from" required aria-label="leave from">
          <input type="date" name="to" required aria-label="leave to">
          <button type="submit">Add leave</button>
        </form>
        <datalist id="member-ids">${memberOptions}</datalist>
      </td>
    </tr>
  </table>

  <h2>Recent facilitators</h2>
  <table>${historyRows || '<tr><td class="empty" colspan="2">no standups yet</td></tr>'}</table>

  <h2>Announcement time</h2>
  <form method="post" action="/settings/time">
    <input type="time" name="time" value="${esc(announceTime)}" required aria-label="daily announcement time">
    <span class="tz">Singapore time (SGT)</span>
    <button type="submit">Save</button>
  </form>
  <p class="hint">The facilitator is announced to Google Chat each working day at this time. Changing the time re-arms today's send — save a new time that has already passed and it goes out again within a few minutes. No redeploy.</p>

  <h2>Google Chat webhook</h2>
  <form method="post" action="/settings/webhook">
    <input type="text" name="webhook" class="wide" value="${esc(webhook)}"
      placeholder="https://chat.googleapis.com/v1/spaces/.../messages?key=..." aria-label="Google Chat webhook">
    <button type="submit">Save</button>
  </form>
  <p class="hint">Empty = announcements off. The daily ${esc(announceTime)} SGT pick is still recorded silently either way.</p>

  <h2>Next notification</h2>
  ${nextNotiSection}

  <h2>Sent history</h2>
  <table>
    <tr><th>Time (SGT)</th><th>Facilitator</th><th>How</th><th>Result</th></tr>
    ${sendRows || '<tr><td class="empty" colspan="4">nothing sent yet</td></tr>'}
  </table>
  <p class="hint">The last 20 real Google Chat deliveries — automatic daily broadcasts and manual Announce presses, successes and failures alike. Nothing is logged when no webhook is configured.</p>
</body>
</html>`;
}

// Calendar-only styling: a 7-column Mon–Sun grid, still flat and thin-lined to
// match STYLE. Kept beside renderCalendar because it is purely a rendering concern.
const CALENDAR_STYLE = `
  .cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; background: #8883; border: 1px solid #8883; }
  .cal .dow { padding: 0.3rem 0.4rem; font-size: 0.7rem; text-transform: uppercase; opacity: 0.5; font-weight: 600; text-align: center; }
  .cal .cell { background: #fff; min-height: 3.6rem; padding: 0.3rem 0.4rem; display: flex; flex-direction: column; }
  @media (prefers-color-scheme: dark) { .cal .cell { background: #111; } }
  .cal .cell.outside { opacity: 0.35; }
  .cal .cell.weekend .who { display: none; }
  .cal .cell.today { outline: 2px solid #3b82f6; outline-offset: -2px; }
  .cal .daynum { font-size: 0.75rem; opacity: 0.6; }
  .cal .cell.today .daynum { opacity: 1; font-weight: 700; color: #3b82f6; }
  .cal .who { margin-top: auto; font-size: 0.9rem; line-height: 1.2; }
  .cal .who.predicted { opacity: 0.6; font-style: italic; }
  .cal .sent { color: #16a34a; font-weight: 700; }
  .cal-nav { display: flex; align-items: baseline; gap: 1rem; margin: 1rem 0; }
  .cal-nav .month { font-size: 1.1rem; font-weight: 600; }
  .legend { font-size: 0.8rem; opacity: 0.6; margin-top: 0.8rem; display: flex; gap: 1.2rem; flex-wrap: wrap; }
`;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// renderCalendar draws the month grid. It reuses the SAME todayPick the main
// portal's Today line uses (repo.on(today)) and hands it to the pure buildMonth,
// so the "today" cell and the Today line are the same value — the owner's added
// acceptance criterion holds by construction, not by a parallel computation.
async function renderCalendar(repo: Repo, today: string, monthParam: string | null): Promise<string> {
  // Which month to show: a valid ?month=YYYY-MM, else today's SGT month.
  let year: number, month: number;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    year = Number(monthParam.slice(0, 4));
    month = Number(monthParam.slice(5, 7));
  } else {
    year = Number(today.slice(0, 4));
    month = Number(today.slice(5, 7));
  }

  const roster = await repo.roster();
  const leaves = await repo.leaves();
  // 366 covers a full past year of daily picks so any navigated month renders its
  // recorded history; predict() inside buildMonth fills the future half.
  const recent = await repo.recent(366);
  const todayPick: Facilitation | null = await repo.on(today);
  // Sent history for the ✓ marks: the SGT date of every successful delivery. 500
  // rows ≈ a year-plus of daily sends, enough to mark any month in view.
  const sends = await repo.recentSends(500);
  const sentDates = new Set(
    sends.filter((s) => s.result === "sent").map((s) => formatSgt(s.sentAt).slice(0, 10)),
  );

  const cells: MonthCell[] = buildMonth(
    roster, recent, leaves, sentDates, today, todayPick, year, month,
  );

  // The Today line, IDENTICAL to the main portal's — rendered here so the owner
  // can eyeball it against the highlighted today cell on the same page.
  const memberName = (id: string): string => roster.members.find((m) => m.id === id)?.name ?? id;
  const todayLine = todayPick
    ? `<strong>${esc(memberName(todayPick.memberId))}</strong>`
    : `<em>not picked yet</em>`;

  // Month navigation.
  const prev = month === 1 ? `${year - 1}-12` : `${year}-${pad2(month - 1)}`;
  const next = month === 12 ? `${year + 1}-01` : `${year}-${pad2(month + 1)}`;
  const label = `${MONTH_NAMES[month - 1]} ${year}`;

  const dowHeader = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map((d) => `<div class="dow">${d}</div>`)
    .join("");

  const cellHtml = cells
    .map((c) => {
      const cls = [
        "cell",
        c.inMonth ? "" : "outside",
        c.weekend ? "weekend" : "",
        c.isToday ? "today" : "",
      ].filter(Boolean).join(" ");
      const day = Number(c.date.slice(8, 10));
      const who = c.member
        ? `<div class="who ${c.origin === "predicted" ? "predicted" : ""}">${c.sent ? '<span class="sent">✓</span> ' : ""}${esc(c.member.name || c.member.id)}</div>`
        : "";
      return `<div class="${cls}"><span class="daynum">${day}</span>${who}</div>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Standup Roster — Calendar</title>
<style>${STYLE}${CALENDAR_STYLE}</style>
</head>
<body>
  <div class="topbar">
    <h1>Standup Calendar</h1>
    <span><a href="/">← Back to roster</a></span>
  </div>
  <div class="today">Today (${esc(today)}): ${todayLine}</div>

  <div class="cal-nav">
    <a href="/calendar?month=${prev}">← ${prev}</a>
    <span class="month">${esc(label)}</span>
    <a href="/calendar?month=${next}">${next} →</a>
  </div>

  <div class="cal">
    ${dowHeader}
    ${cellHtml}
  </div>

  <div class="legend">
    <span><span class="sent">✓</span> announced (from Sent history)</span>
    <span><em>italic</em> = predicted (not yet recorded)</span>
    <span>weekends left blank</span>
    <span>today outlined</span>
  </div>
  <p class="hint">Past working days show the recorded facilitator; today shows the recorded pick (same as the Today line above); future days are projected from the current rotation, order and leave — the same rule the daily announcement uses, so the calendar never disagrees with what actually gets sent.</p>
</body>
</html>`;
}
