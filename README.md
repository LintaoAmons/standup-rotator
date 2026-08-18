# standup-rotator

Picks who facilitates the next standup. Given the roster, who facilitated last, and who is
on leave, it advances the rotation, records the pick, and announces it to Google Chat — all
from one **Cloudflare Worker + D1**. No server, no container, no cron host of your own.

## Built by talking to UnDercontrol

This whole app was built by conversation. I never opened an editor for it — I described what
I wanted by talking to [**UnDercontrol**](https://ud.oatnil.com) remotely, from my daily
stand-up notes, and its coding agent found the old tool, rewrote it, wrote the tests,
deployed it to Cloudflare, and read back the live result — each request shipped the **same
day** it was asked for.

It started as a legacy Go CLI that read local CSV files. Across a handful of plain-language
requests it became the Worker you see here:

- "rewrite it as a fully-managed Cloudflare app, no server of mine" → single Worker + D1
- "add CRUD, I'll obviously need to edit the roster" → in-page add / rename / reorder / remove
- "put a login password on it" → one-password gate, secret-derived sessions
- "let me set and rotate the Google Chat webhook from the page" → webhook moved into D1
- "add another kind of skip — just skip, don't push the person forward" → two skip modes
- "can I configure the send time?" → portal-editable announcement time (SGT)
- "add a sent history" → an audit panel of every delivery, successes and failures
- "make send and rotation independent — always send" → decoupled send, slot-gated broadcast
- "show me when the next notification goes out" → a live "Next notification in Xh Ym" countdown

No tickets, no branches to babysit, no hand-offs — the requirement, the code, the tests and
the deploy were one continuous conversation, and the same agent that wrote it verified it
running in production. That is what UnDercontrol is for: [ud.oatnil.com](https://ud.oatnil.com)
· [oatnil.com](https://oatnil.com).

*(This is a real internal tool, published as-is. It is not a template or a starter — just an
honest example of what "talk to it and it ships" looks like end to end.)*

## What it does

| Surface | Trigger | Behaviour |
|---|---|---|
| `GET /login`, `POST /login` | a browser | The password gate (see below). The only routes reachable without a session. |
| `GET /today` | a UI | Ensure today has a pick and return it as JSON. Idempotent — repeated calls never re-pick. Does not announce. |
| `POST /skip` | two UI buttons | The current facilitator steps aside and the next available member takes today. The `mode` form field picks the kind: **`requeue`** ("Skip (goes next)") requeues the skipped person as next — tomorrow is them (order changes); **`pass`** ("Skip (pass)") leaves the rotation order untouched — the skipped person waits their natural turn. Default `requeue`. See the rules table. Persists, then redirects to `/`. |
| `POST /trigger` | a UI button (beside Skip) | Announce **today's** facilitator to Google Chat **now, without rotating**. When no webhook is configured it does not silently no-op — it redirects with a visible hint to set the webhook first. Every real POST (this and the auto broadcast) records a **Sent history** row, successes and failures alike. |
| `GET /` | a browser | Status **and editing** page: today's pick, **Next up (predicted)** for the coming working days, the rotation (with add / rename / reorder / remove), leave (add / remove), recent facilitators, the **announcement time** (SGT), the Google Chat webhook, a live **Next notification** countdown, and **Sent history** (the last 20 real deliveries, times in SGT). Never triggers a pick on load. |
| `POST /members/{add,rename,delete,move}`, `POST /leave/{add,delete}` | the page's forms | Roster and leave CRUD. Each redirects back to `/` (Post/Redirect/Get), a rename with a `Saved.` confirmation. |
| `POST /settings/time`, `POST /settings/webhook` | the page's forms | Set the daily announcement time (HH:MM, **SGT**) and the Google Chat webhook. Validated before storing; effective on the next tick, no redeploy. |
| cron `scheduled` | Cloudflare cron (every 5 min) | Heartbeat. Every working-day tick **advances the rotation** (idempotent daily pick). **Decoupled** from that, a runtime gate (`shouldAnnounce`) sends today's facilitator to Google Chat **once per (date, configured-time) slot** — so editing the announcement time re-arms today's send. The send is a pure projection and never advances the rotation. **Not gated** by the password — runs regardless. |

## Password gate

The whole web surface is behind **one shared password**, held only as the Worker secret
`APP_PASSWORD` (never in code or `wrangler.jsonc`). Unauthenticated requests get no content:
`GET /` redirects to `/login`, every JSON/CRUD route returns a bare `401`. The cron
`scheduled` handler is invoked by the runtime directly, not through `fetch`, so it keeps
running while the web is locked.

`src/auth.ts` holds it, and it is deliberately minimal — no user model, no recovery:

- **Login** compares the submitted password against `APP_PASSWORD` in constant time
  (double-HMAC, since Web Crypto has no `timingSafeEqual`). Failure says only "incorrect".
- **Session** is a cookie whose value is `HMAC-SHA256(APP_PASSWORD, label)` — derived from
  the secret, never the password itself, and unforgeable without it. Cookie is `HttpOnly;
  Secure; SameSite=Lax`. Rotating `APP_PASSWORD` invalidates every outstanding cookie for
  free (the derived token changes), so there is no session store to purge.
- **Unconfigured fails closed**: with no `APP_PASSWORD` set, nobody can log in — the gate
  never falls open.

CRUD edits touch roster and leave only, never `history`, so `next()` and idempotency hold
under any edit — including removing the person already picked today (the pick stays recorded
and truthful; tomorrow advances past them). These cases are pinned in `test/crud.test.ts`.

`?date=YYYY-MM-DD` may be appended to `/today`, `/skip` and `/` to drive a specific day in
testing; production omits it and uses the current standup day in **Singapore time**
(SGT = UTC+8). Cloudflare cron fires in UTC, so the Worker converts to the SGT calendar day
and wall-clock itself (`STANDUP_UTC_OFFSET_MINUTES` in `src/domain.ts`) — the announcement
gate reckons both the working-day and the time in SGT, so the cron stays a plain UTC
heartbeat with no timezone math in the schedule. See `DEPLOY.md`.

## Rotation rules

`next()` in `src/domain.ts` is a pure function — no I/O, no clock, no config — and defines
these cases rather than discovering them in production. All are covered by `test/domain.test.ts`.

| Situation | Behaviour |
|---|---|
| No history yet | First roster member |
| Normal run | The next member after the last facilitator, wrapping at the end |
| Someone on leave | Skipped, rotation continues past them |
| Last facilitator has left the team | Resume after the newest facilitator still on the roster — never restart at the top |
| Everyone on leave | Explicit error, never an arbitrary pick |
| **Skip · goes next** | The replacement runs today; the skipped person is **requeued as next** (moved right behind the replacement in the rotation order), so tomorrow is them — they do not sink to the back to wait a whole cycle. This is `skipStandup("requeue")` + `moveAfter`; `next()` itself is unchanged. |
| **Skip · pass** | The replacement runs today, but the rotation **order is left untouched** — the skipped person is not requeued and waits their natural turn (the rotation continues from the replacement, so they come back around after a full cycle). This is `skipStandup("pass")` — identical to `requeue` minus the `moveAfter` reorder. |
| Single-member roster | That member repeats; legal, not an error |

## Idempotency

`history.date` is the **PRIMARY KEY (UNIQUE)**. A same-day re-trigger — cron, a page refresh,
a repeated `GET /today` — hits the existing row and returns it without picking again. A
`POST /skip` upserts (`ON CONFLICT(date) DO UPDATE`) the day's single authoritative row
rather than appending. History is always committed **before** any announcement, so a chat
outage can never cause the same person to be picked twice.

## Architecture

```
src/domain.ts    Member/Roster/Leave/Facilitation + next()/unavailable()/covers()/moveInOrder()/predict() — pure
src/service.ts   runStandup() + skipStandup() + runScheduledTick(): idempotency -> pick -> record -> (decoupled) notify
src/repo.ts      Repo port + D1Repo (reads + roster/leave CRUD + settings + send log)
src/auth.ts      password gate: constant-time verify, secret-derived session cookie
src/notify.ts    Google Chat webhook notifier (optional)
src/worker.ts    fetch (login, /today, /skip, /trigger, CRUD, settings, /) + scheduled (cron), embedded HTML
test/            domain + service + auth + crud + settings + send-log + announce unit tests (vitest), in-memory Repo fake
schema.sql       D1 tables (roster, leave, history, settings, send_log)
seed.sql         sample team for local testing
```

Every dependency points inward: `domain` knows nothing of D1 or fetch, `service` depends
only on the `Repo` port and an injected `notify` callback. This is what makes the whole use
case unit-testable with an in-memory fake and no Worker runtime.

## Develop & test locally (no Cloudflare login required)

```sh
npm install
npm test                 # unit tests: rotation edges + orchestration/idempotency + CRUD + auth + settings + send log
npm run typecheck

# local D1 (miniflare — a local SQLite file under .wrangler/, no login):
npm run db:local         # apply schema.sql
npm run seed:local       # load the sample team
# set a throwaway local password so the gate lets you in during dev:
echo 'APP_PASSWORD="localdev"' > .dev.vars     # .dev.vars is gitignored; NOT the prod password
npm run dev              # wrangler dev on http://localhost:8787

curl 'http://localhost:8787/today?date=2026-07-21'
curl -X POST 'http://localhost:8787/skip?date=2026-07-21' -d mode=requeue  # or mode=pass
open  'http://localhost:8787/'
# scheduled path (start dev with --test-scheduled):
curl 'http://localhost:8787/__scheduled'
```

## Google Chat announcement

Optional and off by default. The webhook lives in **D1** (portal-editable, not a secret):
sign in and paste it into the **Google Chat webhook** field on the page. The Worker
announces **only if** that field is non-empty; empty == off, and scheduled runs then pick
and record silently and never error. The daily send time is set in the **Announcement time**
field (HH:MM, SGT; default 09:00). Editing it **re-arms** today's send — save a new time that
has already passed and it goes out again within minutes — see `DEPLOY.md`.

Every real delivery — the auto broadcast and the manual **Announce** button — is recorded in
the **Sent history** panel (last 20, newest first, times in SGT), including **failures** with
a short reason. A send that never happens (no webhook configured) is not a delivery and is not
logged, so the panel is signal, not noise.

The page also shows a live **Next notification in Xh Ym** countdown. The moment is computed
server-side by the pure `nextNotification()` from the real send semantics — working day,
configured time, and whether today's slot has already gone out, all in SGT — so a Friday
after the send, and Saturday/Sunday, all count down to Monday. Because the cron checks every
5 minutes, the actual send lands within ~5 minutes of that time, and the indicator says so
(**±5 min**). With **no webhook configured** it shows "no webhook configured" rather than
counting down to a broadcast that cannot happen.

## Deploy

Three steps after `wrangler login`, all in **`DEPLOY.md`**:

1. `wrangler d1 create standup-rotator` and paste the returned `database_id` into `wrangler.jsonc`.
2. Apply the schema to the remote D1 (`schema.sql`), then set the login secret
   (`wrangler secret put APP_PASSWORD`).
3. `wrangler deploy`. Sign in, add the roster, and paste the Google Chat webhook into the page.

The `database_id` in `wrangler.jsonc` is a resource identifier, not a credential — it is
useless without a Cloudflare API token, so it is safe in a public repo. The login password
and the webhook are **never** committed (`.dev.vars` is gitignored; the prod webhook lives in
D1, the prod password in a Cloudflare secret).
