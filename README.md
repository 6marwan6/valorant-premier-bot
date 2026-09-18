# Valorant Premier Discord AI Assistant

Private Discord bot for a 6–7 person Valorant Premier team. See
`Full_Development_Plan.md` (included alongside this repo) — that file is
the single source of truth for scope and behavior; this README only covers
how to run what's built so far and the decisions made while building it.

## Status: Phase 1 — Discord Foundation ✅

Per plan section 59, Phase 1 scope is: Discord bot, Discord authentication,
slash commands, admin permissions, basic configuration — **no AI**. That's
exactly what's implemented:

- Discord gateway client (`src/discord/client.ts`), minimal intents
- `/setup` slash command (plan sections 41, 53) — admin-only, writes the
  per-guild `server_config` row (timezone, match channel, admin role,
  reminder schedule, default roast intensity, default memory policy)
- Admin permission check (plan section 55) — native Discord Administrator
  OR the configured `admin_role_id`
- PostgreSQL + Drizzle ORM, with a `database/repositories/` layer (plan
  section 7) so nothing outside `ServerConfigRepository` touches SQL
  directly
- Structured logging (plan section 51) — no message content, no PII, just
  event/id/latency fields
- Command deploy script, migration runner
- 24 unit tests + 4 integration tests against a real Postgres instance (28
  total, all passing) — see "Testing" below

Nothing from Phase 2 onward (matches, attendance, AI, memory) is built yet
— this is intentionally a thin, verifiable slice.


## Architecture decisions made (plan left these open)

The plan explicitly defers some choices ("exact provider should be
selected after evaluating...", "ORM/DB library unspecified beyond
'Prefer PostgreSQL'"). Decisions made so far, all reversible:

| Decision | Choice | Why |
|---|---|---|
| Language/runtime | Node.js + TypeScript (plan section 7, explicit) | — |
| ORM | Drizzle ORM + `pg` | Lightweight, fits the plan's explicit `database/repositories/` pattern better than a heavier client, works well on low-cost/serverless-friendly hosts (plan section 6) |
| Discord connection | Gateway (`discord.js` `Client`), not HTTP-only interactions | Phase 8 (memory extraction, plan section 45) needs to listen to messages in specific channels, which requires a gateway connection anyway (HTTP interactions only cover commands/buttons). Building on gateway from day one avoids a rewrite later (plan principle #12). A **managed low-cost host** (e.g. Railway/Fly.io/Render) is still consistent with plan section 6 — section 4 excludes self-managed **VPS** infrastructure specifically, not all persistent processes |
| Command scope | Guild commands, not global | Plan section 54: single-server only, and guild commands update instantly instead of taking up to an hour to propagate |
| Validation | `zod` for env vars and (later) AI structured output | Matches plan section 36/60's emphasis on validating structured data before trusting it |
| Logging | `pino` | Structured JSON by default (plan section 51), pretty-printed only in dev |

## Project layout

Matches plan section 7 exactly:

```
src/
├── discord/{commands,interactions,events,embeds}/
├── modules/{players,matches,attendance,reminders,ai,memories}/   (mostly empty until their phase)
├── database/{schema,repositories}/
├── services/{discord,ai,retrieval,scheduling}/                  (empty until their phase)
├── config/           # env.ts, logger.ts
└── index.ts
```

## Setup

```bash
npm install
cp .env.example .env
# fill in DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, DATABASE_URL

npm run db:generate   # only needed after changing schema files
npm run db:migrate    # applies drizzle/ migrations to DATABASE_URL
npm run deploy-commands  # registers /setup with your test guild
npm run dev            # starts the bot (tsx watch)
```

For production: `npm run build && npm start`.

## Testing

Mirrors plan section 60's split between unit and integration tests:

```bash
npm test               # unit tests only — no infrastructure needed (24 tests)
npm run test:integration  # requires DATABASE_URL pointing at a disposable
                           # Postgres with migrations applied (4 tests)
```

`tests/integration/serverConfigRepository.test.ts` self-skips (rather than
failing) when `DATABASE_URL` isn't set, so `npm test` stays fast and
infra-free by default while CI (or you, locally) can opt into the full
suite by setting `DATABASE_URL` and running `npm run test:integration`.

What's covered so far, mapped to plan section 60's checklist:
- ✅ Permission checks (`tests/unit/permissions.test.ts`,
  `tests/unit/checkAdminFromInteraction.test.ts`)
- ✅ Timezone validation (`tests/unit/timezone.test.ts`)
- ✅ `server_config` repository upsert semantics — partial updates don't
  clobber untouched fields (`tests/integration/serverConfigRepository.test.ts`)
- ⬜ Match state transitions, attendance state changes, reminder
  scheduling, memory visibility, protected-topic filtering, AI output
  validation — all depend on tables/features that don't exist until later
  phases; will be added alongside each phase, not retrofitted at the end

## Roadmap (plan section 59)

- [x] Phase 1 — Discord Foundation
- [ ] Phase 2 — Match System (`/create-match`, `/edit-match`,
      `/cancel-match`, match lifecycle)
- [ ] Phase 3 — Attendance (buttons, public roster message)
- [ ] Phase 4 — Scheduling (reminders, idempotency, DST handling)
- [ ] Phase 5 — Player Profiles (`/add-player`, roles, agents, AI settings,
      protected topics)
- [ ] Phase 6 — Basic AI (CELEBRATE / ROAST / CONSOLE, no memory yet)
- [ ] Phase 7 — Private AI Conversations (DM flow, follow-ups)
- [ ] Phase 8 — Memory System
- [ ] Phase 9 — Retrieval (structured + semantic + privacy filtering)
- [ ] Phase 10 — Match Hype / Recaps

Each phase will be checked against `Full_Development_Plan.md` before
implementation, per the ground rule for this project.
