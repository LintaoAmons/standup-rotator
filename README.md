# standup-rotator (Cloudflare)

Picks who facilitates the next standup. Given the roster, who facilitated last, and who is
on leave, it advances the rotation, records the pick, and (optionally) announces it to
Google Chat.

Runs as a **single Cloudflare Worker + D1** — no server, no container, no cron host of your
own. This is a TypeScript rewrite of the original Go `standup-rotator`, which ran offline
against local CSV files; the rotation rules are ported unchanged (and re-covered by unit
tests), while storage moved from CSV to D1 and the trigger moved from a CLI to the Worker's
HTTP + cron handlers.

## What it does

| Surface | Trigger | Behaviour |
|---|---|---|
| `GET /login`, `POST /login` | a browser | The password gate (see below). The only routes reachable without a session. |
| `GET /today` | a UI | Ensure today has a pick and return it as JSON. Idempotent — repeated calls never re-pick. Does not announce. |
| `POST /skip` | two UI buttons | The current facilitator steps aside and the next available member takes today. The `mode` form field picks the kind: **`requeue`** ("Skip (goes next)") requeues the skipped person as next — tomorrow is them (order changes); **`pass`** ("Skip (pass)") leaves the rotation order untouched — the skipped person waits their natural turn. Default `requeue`. See the rules table. Persists, then redirects to `/`. |
| `POST /trigger` | a UI button (beside Skip) | Announce **today's** facilitator to Google Chat **now, without rotating**. When no webhook is configured it does not silently no-op — it redirects with a visible hint to set the webhook first. Every real POST (this and the auto broadcast) records a **Sent history** row, successes and failures alike. |
| `GET /` | a browser | Status **and editing** page: today's pick, **Next up (predicted)** for the coming working days, the rotation (with add / rename / reorder / remove), leave (add / remove), recent facilitators, the **announcement time** (SGT), the Google Chat webhook, and **Sent history** (the last 20 real deliveries, times in SGT). Never triggers a pick on load. |
| `POST /members/{add,rename,delete,move}`, `POST /leave/{add,delete}` | the page's forms | Roster and leave CRUD. Each redirects back to `/` (Post/Redirect/Get), a rename with a `Saved.` confirmation. |
| `POST /settings/time` | the page's form | Set the daily announcement time (HH:MM, **SGT**). Validated before storing; effective on the next tick, no redeploy. |
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
| **Skip · goes next** (owner rule, 2026-08-18) | The replacement runs today; the skipped person is **requeued as next** (moved right behind the replacement in the rotation order), so tomorrow is them — they do not sink to the back to wait a whole cycle. This is `skipStandup("requeue")` + `moveAfter`; `next()` itself is unchanged. |
| **Skip · pass** (owner rule, 2026-08-18) | The replacement runs today, but the rotation **order is left untouched** — the skipped person is not requeued and waits their natural turn (the rotation continues from the replacement, so they come back around after a full cycle). This is `skipStandup("pass")` — identical to `requeue` minus the `moveAfter` reorder. |
| Single-member roster | That member repeats; legal, not an error |

## Idempotency

`history.date` is the **PRIMARY KEY (UNIQUE)**. A same-day re-trigger — cron, a page refresh,
a repeated `GET /today` — hits the existing row and returns it without picking again. A
`POST /skip` upserts (`ON CONFLICT(date) DO UPDATE`) the day's single authoritative row
rather than appending. History is always committed **before** any announcement, so a chat
outage can never cause the same person to be picked twice.

## Architecture

```
src/domain.ts    Member/Roster/Leave/Facilitation + next()/unavailable()/covers()/moveInOrder() — pure
src/service.ts   runStandup(): check idempotency -> pick -> record -> notify
src/repo.ts      Repo port + D1Repo (reads + roster/leave CRUD)
src/auth.ts      password gate: constant-time verify, secret-derived session cookie
src/notify.ts    Google Chat webhook notifier (optional)
src/worker.ts    fetch (login, /today, /skip, CRUD, /) + scheduled (cron), embedded HTML
test/            domain + service + auth + crud unit tests (vitest), in-memory Repo fake
schema.sql       D1 tables (roster, leave, history, settings, send_log)
seed.sql         sample team for local testing
```

Every dependency points inward: `domain` knows nothing of D1 or fetch, `service` depends
only on the `Repo` port and an injected `notify` callback. This is what makes the whole use
case unit-testable with an in-memory fake and no Worker runtime.

## Develop & test locally (no Cloudflare login required)

```sh
npm install
npm test                 # unit tests: rotation edges + orchestration/idempotency + CRUD + auth
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
has already passed and it goes out again within minutes (owner rule, 2026-08-18) — see `DEPLOY.md`.

Every real delivery — the auto broadcast and the manual **Announce** button — is recorded in
the **Sent history** panel (last 20, newest first, times in SGT), including **failures** with
a short reason. A send that never happens (no webhook configured) is not a delivery and is not
logged, so the panel is signal, not noise.

## Deploy

See **`DEPLOY.md`** — the exact commands master runs after `wrangler login`.
