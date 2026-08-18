# Deploy checklist — what master runs after logging in

Everything below needs a Cloudflare account and `wrangler login`; nothing above this line
does. The code, schema, and tests are already verified locally against miniflare's local D1.

## The three commands (minimum to go live)

```sh
# 1. Authenticate (opens a browser; one-time per machine).
npx wrangler login

# 2. Create the D1 database, then paste the printed database_id into wrangler.jsonc,
#    replacing "PLACEHOLDER_SET_AFTER_D1_CREATE".
npx wrangler d1 create standup-rotator

# 3. Apply the schema to the REMOTE database and deploy the Worker.
npx wrangler d1 execute DB --remote --file=schema.sql
npx wrangler deploy
```

After step 3 the Worker is live at `https://standup-rotator.<your-subdomain>.workers.dev`
and the cron is active.

### Migrating an ALREADY-deployed database (run once)

`schema.sql` declares the newer `settings` columns (`announce_time`, `last_sent_slot`) for a
**fresh** database, but `CREATE TABLE IF NOT EXISTS` will NOT add them to a settings table
that already exists in prod. If the Worker is already live from an earlier version, run the
one-time migration before deploying this version:

```sh
npx wrangler d1 execute DB --remote --file=migrate-announce-time.sql
```

It's not idempotent (SQLite has no `ADD COLUMN IF NOT EXISTS`); running it twice errors with
"duplicate column name", which just means it already applied. Run it exactly once. A
brand-new database created via `schema.sql` needs nothing here.

Then, for the **Sent history** feature (7th round), add the new `send_log` table to the
already-deployed database:

```sh
npx wrangler d1 execute DB --remote --file=migrate-send-log.sql
```

This one only `CREATE TABLE IF NOT EXISTS`, so unlike the columns migration it **is**
idempotent — re-running it is harmless. A brand-new database created via `schema.sql` already
has the table and needs nothing here.

Then, for the **send/rotation decouple** (8th round), swap the retired `announced_date`
column for the new `last_sent_slot` key. Run this **after** `migrate-announce-time.sql`:

```sh
npx wrangler d1 execute DB --remote --file=migrate-decouple-send.sql
```

Not idempotent (it `ADD`s one column and `DROP`s another); re-running errors ("duplicate
column name" / "no such column"), which just means it already applied. Run it exactly once.
It carries the old once-per-day stamp forward so a mid-day deploy does not double-post. A
brand-new database created via `schema.sql` already has `last_sent_slot` and needs nothing.

### Announcement time — set it from the portal, no redeploy

The daily announcement time is **portal-configurable**, not baked into the cron. Sign in and
set it in the **Announcement time** field (near the bottom, labelled *Singapore time*); it
takes effect within a few minutes. Default is **09:00 SGT**.

How it works (so a future change to the cron doesn't break it): Cloudflare cron is static at
deploy time and always UTC, so it can't carry a user-editable time. Instead the cron is a
plain **every-5-minute heartbeat** (`*/5 * * * *` in `wrangler.jsonc`), and a runtime gate
(`shouldAnnounce` in `src/domain.ts`) decides the send — reckoning both the working-day and
the time **in SGT** (`STANDUP_UTC_OFFSET_MINUTES`). The cron is deliberately **not**
restricted to `1-5`: a UTC weekday isn't an SGT weekday at the edges (SGT Monday 00:00–07:59
is still Sunday UTC), so a UTC `1-5` would miss early-Monday SGT times and leak into Saturday
SGT. Letting it tick daily and gating in SGT removes that skew.

**Send is decoupled from rotation (8th round).** Every working-day tick advances the rotation
(the daily pick), independent of the send time. The send is a pure projection of that pick,
gated once per **(date, configured time) slot** — so editing the announcement time re-arms
today's send (`last_sent_slot` embeds the time). Change the time to a value already past and
the next heartbeat re-sends within minutes; change it three times and it sends three times.
The send never advances the rotation. Nearly every tick is a cheap no-op send; late ticks
within a slot still catch up if the worker was down at the exact minute.

You should not need to touch the cron. Leave `*/5 * * * *` as-is and change the time in the
portal.

## Load your team

Edit `seed.sql` with the real roster (keep `position` ascending — it is the rotation order),
then:

```sh
npx wrangler d1 execute DB --remote --file=seed.sql
```

Or insert rows directly with `npx wrangler d1 execute DB --remote --command "INSERT ..."`.

## Enable Google Chat announcements (set it from the portal — no wrangler needed)

Off until this is done; scheduled runs pick and record silently until then.

The webhook is **no longer a Worker secret** — it lives in D1 and is edited from the
logged-in portal, so master sets and rotates it entirely from the browser:

1. In Google Chat: Space -> Apps & integrations -> Webhooks -> add one, copy the URL.
2. Sign in to `https://standup-rotator.<subdomain>.workers.dev/`, paste the URL into the
   **Google Chat webhook** field near the bottom, and press Save.

No redeploy, no CLI. The next scheduled run reads it from D1 and starts announcing.
To turn announcements back off: clear the field and Save (empty == off).

## Password gate (`APP_PASSWORD`)

The whole web surface is behind one shared password, stored only as a Worker secret. It is
**already set** on the live Worker; the plaintext lives only on this machine at
`~/.config/cloudflare/standup-rotator.pass` (mode `0600`) — it is never in the repo, logs, or
this file.

To read it back (to hand it to the team):

```sh
cat ~/.config/cloudflare/standup-rotator.pass
```

To rotate it — pick a new value and re-put the secret; every existing login is invalidated
the moment the secret changes (sessions are derived from it):

```sh
openssl rand -base64 24 | tr -d '\n' > ~/.config/cloudflare/standup-rotator.pass
chmod 600 ~/.config/cloudflare/standup-rotator.pass
cat ~/.config/cloudflare/standup-rotator.pass | npx wrangler secret put APP_PASSWORD
```

No redeploy needed. With no `APP_PASSWORD` set at all, the gate fails closed (nobody can log
in) — it never falls open.

## Verify after deploy

```sh
# unauthenticated is blocked: / redirects to /login, /today is 401
curl -s -o /dev/null -w '%{http_code}\n' 'https://standup-rotator.<subdomain>.workers.dev/today'   # 401
open  'https://standup-rotator.<subdomain>.workers.dev/'    # shows the login page; sign in with the password above
# force the cron once to confirm the whole path (pick + record + announce):
npx wrangler dev --remote --test-scheduled   # then curl its /__scheduled
```

## Still owed by master (summary)

1. `wrangler login` — no CF credentials exist on the hub yet, so nothing remote could be
   tested here.
2. `wrangler d1 create standup-rotator` and pasting the returned `database_id` into
   `wrangler.jsonc`.
3. The Google Chat webhook URL, pasted into the portal's webhook field (post-deploy,
   whenever it's ready) — no CLI, stored in D1.
4. Decide where the repo lives (GitHub) — code is a self-contained local directory for now.
