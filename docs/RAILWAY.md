# Hosting the gateway worker on Railway

Scope: **only `worker/gateway.ts`** (typed DMs, `@Mari` mentions, voice). Slash
commands, buttons, reminders and cron stay on Vercel + Neon, exactly as plan
sections 4 and 6 describe. Moving the worker from Wispbyte to Railway changes
no application code.

## What was verified before writing this

- `npm ci` succeeds against the committed lockfile (it was previously
  git-ignored; `.gitignore` is fixed so Railway builds the tree you tested).
- `npm run build:worker` produces `dist/gateway.js` (about 3 MB), and from inside
  `dist/` the four external packages (`@discordjs/voice`, `@snazzah/davey`,
  `opusscript`, `dotenv`) all import. On Railway the full install puts them in the
  root `node_modules`, which `dist/gateway.js` resolves, so the
  "voice.disabled / package not found" warnings you saw on Wispbyte should not recur.
- `tsc --noEmit` is clean.
- Not verified from here (no route to Railway or Discord): outbound UDP for
  Discord voice from a Railway container, and the first live gateway connection.

## Railway service settings

Use the dashboard. `railway.json` / `railway.toml` (Config as Code) is deprecated and
stops being read on 2026-12-01, and new services cannot opt into it, so this repo
deliberately ships no `railway.json`.

| Setting | Value |
|---|---|
| Source | the GitHub repo |
| Build command | `npm run build:worker` |
| Start command | `npm run start:worker` |
| Restart policy | On failure or Always |
| Public networking | none (the worker serves no traffic; its `$PORT` health listener is harmless) |
| Volumes | none (the worker holds no state; a volume would also block overlapping deploys) |

The build/start scripts are named `build:worker` / `start:worker` on purpose. Vercel
runs a script named `build` if one exists, so a plain `build` or `start` would make
every Vercel deploy rebuild the worker.

### Variables (service level, not shared with Vercel)

Required: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`,
`DISCORD_PUBLIC_KEY`, `DATABASE_URL` (the Neon pooled string, unchanged),
`GATEWAY_WORKER=true`.

AI: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` (and `LLM_EXTRA_BODY` if you use it).

Voice: `GROQ_API_KEY`, plus any of `VOICE_CHANNEL_ID`, `VOICE_NAME`,
`VOICE_DIRECTION`, `VOICE_PITCH`, `VOICE_STT_LANGUAGE`.

Railway: `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10` so the shutdown handler in
`worker/gateway.ts` (leave voice, destroy the client, end the pool) gets time to run.
The default is 0 seconds before SIGKILL.

Do not set `PORT`; Railway provides it. Do not set `CRON_SECRET` here, the worker
serves no cron routes.

### Which variables go where (complete list, 2026-10-02)

| Variable | Vercel | Railway | Why |
|---|---|---|---|
| `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` | yes | yes | both talk to Discord |
| `DISCORD_PUBLIC_KEY` | yes | yes (unused, but the env schema requires it) | Vercel verifies interaction signatures |
| `DATABASE_URL` | yes | yes | same Neon pooled string |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_EXTRA_BODY`, `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS` | yes | yes | buttons/cron/`/mari` (Vercel) and `@Mari`/DMs/voice replies (Railway) all call the LLM |
| `CRON_SECRET` | yes | no | only the cron endpoints use it |
| `DEFAULT_TIMEZONE`, `MATCH_CHANNEL_ID`, `ADMIN_ROLE_ID` | yes | optional | bootstrap defaults before `/setup`; the database wins afterwards |
| `GATEWAY_WORKER` | unset / `false` | `true` | tells replies a worker exists (drops the Tap Reply button) |
| `GROQ_API_KEY` | yes | yes | Vercel: `/mari-voice` voice notes. Railway: live voice |
| `VOICE_NAME`, `VOICE_DIRECTION`, `VOICE_PITCH`, `VOICE_TTS_MODEL`, `VOICE_ARABIC`, `VOICE_TTS_ARABIC_MODEL`, `VOICE_NAME_AR` | yes | yes | keep identical so a voice note sounds like her live voice |
| `DEEPGRAM_API_KEY`, `VOICE_STT_PROVIDER`, `VOICE_DEEPGRAM_MODEL`, `VOICE_STT_MODEL`, `VOICE_STT_LANGUAGE` | no | yes | speech-to-text only exists in the live worker |
| `VOICE_CHANNEL_ID`, `VOICE_LISTEN`, `VOICE_SILENCE_MS`, `VOICE_MIN_LEVEL`, `VOICE_WARMUP`, `VOICE_DEBUG` | no | yes | live voice behaviour |
| `VOICE_LLM_MODEL`, `VOICE_LLM_MAX_TOKENS` | no | yes | spoken replies only |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | no | yes (`10`) | graceful shutdown |
| `NODE_ENV`, `LOG_LEVEL`, `PORT` | Vercel sets `NODE_ENV`; `LOG_LEVEL` optional | `LOG_LEVEL` optional; never set `PORT` | platform-provided |

## Cutover (order matters)

Two gateway connections on one bot token will both answer, so the old one must be
down first.

1. Create the Railway service and set the variables, but do not deploy yet.
2. **Stop the Wispbyte worker.**
3. Deploy on Railway. Watch the logs for `worker.ready` and, if voice is on,
   `voice.enabled`.
4. Smoke test: DM the bot, `@Mari hi` in the server, `/mari-join`.
5. Delete the Wispbyte project once it has run cleanly for a day.

Redeploys: Railway starts the new container, then sends SIGTERM to the old one. For a
moment two workers can be connected. Text is safe (every turn claims a `source_ref` in
the database, so a message is answered once). Voice can briefly double-join; it
settles when the old container exits.

## Voice first-run check

Set `VOICE_DEBUG=1` for the first test and read the logs. If she joins the channel but
there is no audio either way, the likely cause is the container's outbound UDP to
Discord's voice servers. Report what the logs show before changing code. Turn
`VOICE_DEBUG` back to `0` afterwards.

## Cost (checked 2026-10-01)

Hobby is $5/month and includes $5 of usage; usage is billed per second at roughly
$10 per GB of RAM and $20 per vCPU per month. A bundled worker idling at around
150 to 250 MB should land near the included credit, but watch the usage page for the
first week. This is why the worker runs from the esbuild bundle (`node
dist/gateway.js`) instead of `tsx worker/gateway.ts`: no TypeScript runtime resident
in memory.

## Plan note (for you to approve)

The plan's 2026-09-29 revision describes the worker as running "on a free always-on
host". Railway is low-cost, not free. Suggested replacement sentence for
`docs/Full_Development_Plan.md` section 4:

> **Revision, 2026-10-01 (Marwan, product owner):** the gateway worker runs on
> Railway (Hobby plan, about $5/month) instead of a free host. Scope is unchanged:
> only the worker; the serverless app, Neon and external cron stay as before.
