# Valorant Premier Discord AI Assistant

Private Discord bot for a 6–7 person Valorant Premier team. See
`Full_Development_Plan.md` (included alongside this repo) — that file is
the single source of truth for scope and behavior; this README only covers
how to run what's built so far and the decisions made while building it.

## Status: Phase 7 — Private AI Conversations ✅ (Phases 1–6 also complete)

Jump to [Phase 7 — private conversations](#phase-7--private-ai-conversations-what-was-built-and-the-choices-made)
for the newest work. The Phase 5 notes below are kept as they were.

### Phase 5 — Player Profiles (previous status header)

Per plan section 59, Phase 5 scope is: `/add-player`, `/edit-player`,
roles, agents, AI settings, protected topics. Section 41 groups
`/remove-player` and `/player` alongside those in its admin-command
inventory, so both were built too — the four together are the minimum
needed to actually manage a roster (add someone, fix a typo, retire
someone, and check what's stored, since there's no web dashboard per
plan section 4).

**This phase also settles the two pieces of Phase 3 debt the README
flagged at the time** (see "ordering tensions" below, both marked
resolved) — the public roster message now shows a real "No response"
section and a real `Confirmed: X/Y` denominator, because there's finally
a roster to be honest about.

### Three real ordering tensions in the plan, and how they were resolved

The plan's own phase ordering creates dependencies Phase 3 can't fully
satisfy yet. Rather than quietly build around them, here's each one and
the resolution, so you can override any of them:

**1. Section 15 step 2, "identify the player," implies a `players` table
— but Player Profiles are Phase 5, which comes *after* Attendance (Phase
3) in the plan's own ordering.** Resolution: `attendance` rows key off raw
Discord identity (`discord_user_id` + a `discord_display_name` snapshot
taken at response time), not a `players` FK. This is forward-compatible
on purpose (plan design principle #12: no rewrite of the core
match/attendance system later) — Phase 5 can start joining on
`discord_user_id` without touching this table's shape.

**Resolved in Phase 5, exactly as predicted**: `players` now exists,
keyed on `discord_user_id` per guild, and `rosterMessage.ts` joins
attendance rows against it by that same id — `attendance` itself was
never touched.

**2. Section 16's example roster message names people under "No
response"** — impossible without knowing who's *expected* to respond,
which needs the roster from Player Profiles (Phase 5). Resolution: the
public message shows only actual responses, grouped exactly as section
16's example groups them (empty sections omitted), plus a `Responded: N`
count. No "No response" section, no fabricated `X/6` denominator — both
return once Phase 5 lands.

**Resolved in Phase 5**: `buildRosterMessage` now takes the active roster
(`PlayerRepository.listActiveByGuild`) as a third argument. With a roster
present it renders section 16's example faithfully — a real "⚪ No
response" section and `Confirmed: <playing>/<roster size>` — and falls
back to the old `Responded: N` behavior only if a roster is genuinely
empty (a guild that hasn't run `/add-player` yet), so nothing breaks for
a deployment mid-upgrade.

**3. Section 61's example shows the match message posted automatically
"three hours before" kickoff — that's the reminder system, Phase 4, not
built yet.** Resolution: added `/post-match`, a **provisional** admin
command not named in the plan's section 41 list. It does exactly what
Phase 4's scheduler will eventually do automatically (validate, open for
confirmation, post the buttoned message) but triggered manually. When
Phase 4 is built it should call the same
`AttendanceService.prepareAnnouncement`/`recordAnnouncement` pair this
command uses — `/post-match` likely becomes redundant then (or stays as a
manual "post early" override) rather than being thrown away.

### What's implemented

- `attendance` table: `(match_id, discord_user_id)` unique index enforces
  plan section 15's idempotency requirement ("clicking the same button
  twice... should not create duplicate records") **at the database
  level** via an upsert — proven directly in `psql` before any app code
  was written on top of it
- `matches.announcementChannelId`/`announcementMessageId`: track the
  single posted message per match ("The bot should maintain a single
  match message where possible," section 16)
- `AttendanceService`: validates match state before accepting a response
  (section 15 step 3, "verify the match is accepting responses") and
  before allowing a match to be posted (only from `SCHEDULED`); all
  framework-agnostic, no Discord types
- `buildRosterMessage`: pure function building both the announcement
  (section 14) and the roster (section 16) as one editable message —
  cancelling a match keeps the response history visible but removes the
  buttons entirely, rather than leaving live buttons that would just be
  rejected on click
- A button click edits the public message via `interaction.update()`
  directly (the button's own message) — no separate fetch-by-id needed
  for that path. `/cancel-match` and `/edit-match`, which change match
  state *outside* a button click, push a best-effort refresh to an
  already-posted announcement via `announcementSync.ts`; a Discord-side
  failure there is logged and swallowed, never rolled back, since the
  database is already the source of truth by that point (design
  principle #2)

**100 tests passing** (up from 73 in Phase 2): 61 unit, 39 integration
against real Postgres — including a full `/post-match` → button-click →
message-content e2e suite that **caught a real bug**: the very first
posted announcement was missing its buttons, because it was built from
the match's pre-transition `SCHEDULED` status rather than the
`CONFIRMATION_OPEN` status it was about to have. Fixed in
`postMatch.ts`; regression-tested in `tests/integration/phase3E2E.test.ts`.

### Phase 4 — how reminders actually run

**Reconciliation, not scheduling.** There's no code anywhere that "sets a
timer for 3 hours from now." Instead, `services/scheduling/
reminderCronJob.ts` runs on every external-cron tick (see below) and, for
every match still `SCHEDULED`/`CONFIRMATION_OPEN`, makes sure its
`reminders` rows match what they *should* be right now given
`server_config.reminder_schedule_minutes` and the match's current
`scheduled_at` (`ReminderRepository.reconcileMatch`, an idempotent
upsert). Then, separately, it sends whatever's actually due. This means:

- **Editing a match's time automatically retimes its still-pending
  reminders** — no special-case code in `/edit-match` needed; the next
  cron tick just recomputes them.
- **A crashed or skipped tick isn't a lost reminder** — the next tick
  reconciles from scratch. There's no separate "did generation succeed"
  state to get out of sync with the match itself.
- **The earliest-configured offset is what opens the match for
  confirmation** — plan section 61's example ("posted... three hours
  before kickoff") — calling the exact same
  `AttendanceService.prepareAnnouncement`/`recordAnnouncement` pair
  `/post-match` already used (see that command's updated doc comment for
  how the two now coexist without racing). Every later offset for the
  same match sends a short nudge instead (`modules/reminders/
  reminderMessages.ts`) — attendance tally, no buttons (the roster
  message keeps the only live ones, per section 16).
- **Duplicate-send prevention (plan section 50) is a claim, not a lock**:
  `ReminderRepository.claim()` is a single `UPDATE ... WHERE
  status='PENDING'` — at most one overlapping cron invocation can ever
  win a given reminder. A Discord-call failure after claiming reverts the
  row to `PENDING` (logged, not swallowed) so the next tick retries,
  rather than either silently dropping the reminder or falsely marking it
  sent.

**How it's actually triggered:** `api/cron/reminders.ts`, a Vercel
Function guarded by a bearer-token check (`services/scheduling/
cronAuth.ts`) against `CRON_SECRET` — Discord's own Ed25519 verification
only covers requests Discord itself sends, so a cron endpoint needs its
own auth or anyone who finds the URL could trigger it. Point an external
scheduler (cron-job.org / Upstash QStash — see "Hosting & Deployment") at
it every 5–15 minutes with header `Authorization: Bearer <CRON_SECRET>`.
It's deliberately its own route rather than a generic `?job=` dispatcher:
plain Vercel file routing already gives each cron job (this one now,
Phase 8's message-poll job later) its own URL, schedule, and
`maxDuration` for free; what's actually shared is the auth check and the
context-building boilerplate, not the route itself.

`/post-match` is kept, not retired, now that reminders open matches
automatically — it's the "post early" manual override the Phase 3 section
above predicted, for an admin who doesn't want to wait for the first
scheduled reminder.

**151 tests passing** (up from 100 in Phase 3): 91 unit, 60 integration —
this time actually run against a real local Postgres inside the sandbox
(not just written and left unverified), including a bug the integration
suite caught before you'd have hit it: the very first version of the cron
job re-used a *snapshot* of each match taken before the loop started, so
a second reminder due for the same match in the same tick (a late-created
match where several offsets are already overdue) would read a stale
`announcementChannelId` — still null — and fail. Fixed by tracking
newly-opened channel/message ids in-memory for the rest of that tick;
regression-tested in `tests/integration/phase4E2E.test.ts`.

### Phase 5 — Player Profiles: what was built and the choices made

Four commands, one repository, and one schema change (plan sections 8/9/10/41):

- **`players` table**: one row per `(guild_id, discord_user_id)`
  (enforced by a unique index). Role is a fixed 4-value enum (Duelist /
  Initiator / Controller / Sentinel — plan sections 8/62); agents and
  protected topics are `jsonb` string arrays rather than child tables —
  see `schema/players.ts`'s doc comment for why (design principle #11:
  this is a 6-7 person team, no feature in the plan needs to query
  *across* agents/topics relationally).
- **No hard deletes.** `/remove-player` flips `active = false`, the same
  soft-state pattern `matches` already uses (`CANCELLED`, not row
  deletion). Re-running `/add-player` for someone previously removed
  reactivates their existing row instead of erroring on the unique index
  or creating a second one — `PlayerRepository.upsertByDiscordUserId`
  handles both "new person" and "returning person" through one path.
- **Agent names are intentionally NOT validated against Valorant's actual
  roster.** Riot adds/reworks agents over time; hardcoding a list here
  would eventually reject a real agent this app just doesn't know about
  yet. What *is* enforced (`modules/players/playerValidation.ts`):
  non-empty, de-duplicated, length- and count-bounded input, and — plan
  section 8's own example (Jett listed under Agents *and* set as
  Preferred Agent) — a preferred agent must actually be one of the
  agents just listed.
- **A new adapter capability.** Every command through Phase 4 only ever
  read options *about* the invoker. `/add-player`, `/edit-player`,
  `/remove-player`, and `/player` all target a *different* Discord user,
  and a Discord User-type option's raw value is just an id — the actual
  username/nickname lives in the interaction's `resolved` payload.
  `httpInteractionAdapter.ts` gained `options.getUser()` (nickname →
  global name → username fallback, same order `displayName.ts` already
  used for the invoker) and `options.getBoolean()` (needed for
  `/edit-player`'s six AI-setting toggles) to make that possible.
- **New players start fully opted in, no protected topics** — plan
  section 9's own example shows every reference category "enabled" by
  default. Turning any of them off, or adding protected topics, is
  `/edit-player`'s job specifically (see that file's doc comment for why
  it isn't split across both commands).
- **The Phase 3 roster-message debt is paid off** — see "ordering
  tensions" above. `buildRosterMessage` takes the active roster as an
  optional third argument; all four call sites
  (`announcementSync.ts`, `dispatchButton.ts`, `postMatch.ts`,
  `reminderCronJob.ts`) now fetch it via
  `PlayerRepository.listActiveByGuild` and pass it through.

**This phase's tests were also actually run against a real database, not
just written**: same approach as Phase 4 (`apt-get install postgresql`
inside this sandbox, real `drizzle/` migrations applied, no
mocked/simulated DB layer) — `tests/integration/playerRepository.test.ts`
covers create/read/partial-update/soft-delete/reactivate/uniqueness for
real. **180 tests passing** (up from 151 in Phase 4): 114 unit, 66
integration.

### Phase 6 — Basic AI (summary of what the code does)

Attendance click → `modeForStatus` (PLAYING → CELEBRATE, CANNOT_PLAY → ROAST,
WANTS_TO_BUT_CANNOT → CONSOLE) → `buildAIContext` (player profile, match,
attendance response, AI settings; protected topics as FORBIDDEN) → an
OpenAI-compatible `LlmClient` → `parseAiOutput` (JSON validation, mention
neutralization, protected-topic check on the *output*) → one private
(ephemeral) followup. Every failure resolves to the plan section 48 fallback
and never affects attendance.

### Amendment to plan sections 17/19/61: attendance reactions are public

Decided after Phase 7: roasts and hype only work if the team sees them, so
`PLAYING` (CELEBRATE) and `CANNOT_PLAY` (ROAST) are now posted in the match
channel, @mentioning the player (`allowed_mentions` limits pings to that one
user). `WANTS_TO_BUT_CANNOT` posts only a fixed "can't make it this time 🟡"
line — no AI text, no reason, no roast — and the *why* stays in the private
DM. If the AI fails, the safe fallback goes to the player privately, never
into the channel. Not built: letting a player allow a public roast from
inside the DM chat (needs Phase 8's consent/memory flow), and any
one-public-message-per-player-per-match limit (flipping answers posts again).

### Phase 7 — Private AI Conversations: what was built and the choices made

Plan section 59 scope: *Discord DM, conversation state, follow-up questions,
CONSOLE conversation flow.* Section 20 says CONSOLE is the mode that talks
back ("What happened?" … "The player can respond naturally"), and section
61's example shows exactly this: opener in a DM, the player answers, the AI
continues. So:

- **CONSOLE (`WANTS_TO_BUT_CANNOT`) is now a real DM conversation.** The
  button click only gets a short private pointer ("I sent you a DM").
- **CELEBRATE and ROAST are unchanged** — single private messages (sections
  18/19; nothing in the plan gives them a back-and-forth).
- **Memory is still Phase 8.** `memory_candidate` is accepted and discarded
  exactly like Phase 6, and the prompt forbids the model from offering to
  "remember" anything. The `[Remember]/[Don't Remember]` buttons from
  section 61's example belong to Phase 8 (section 21), so they aren't here.

**The ordering tension (same style as the Phase 3 notes above): a typed DM
reply can't reach an HTTP-Interactions app.** Discord only pushes
*interactions* to the endpoint; an ordinary message typed into a DM is
delivered via the gateway, which the serverless hosting choice rules out
(README "Hosting & Deployment"; plan sections 4/6). Two paths therefore feed
the same `ConversationService.handlePlayerReply`:

1. **💬 Reply button → modal** (instant, needs no setup). Every bot DM that
   expects an answer carries a Reply button; its modal submit *is* an
   interaction. The reply is echoed back as a quote above the bot's answer
   (text entered in a modal never appears in the chat by itself), and the
   answered message's button is removed.
2. **Typed replies, via an optional cron poll** (`api/cron/dm-replies.ts`) —
   the same cron-polling design already decided for Phase 8. Not instant, and
   only works once you schedule it. A burst of typed messages is joined into
   one turn.

Both are idempotent against retries *and against each other* — see below.

**Data (plan section 29)** — migration `0005_add_ai_conversations.sql`:
`ai_conversations` (id, player_id, match_id, mode, started_at, ended_at, plus
`guild_id`, `end_reason`, `dm_channel_id`, `last_seen_message_id`,
`last_activity_at`) and `ai_messages` (id, conversation_id, role, content,
created_at, plus `source_ref`). Departures from section 29's literal field
list are only what the DM transport and idempotency need. Roles are the
plan's USER / ASSISTANT / SYSTEM (Phase 7 writes the first two).

**Conversation rules, all enforced by the backend (section 37), never by the
model:**

| Rule | Where |
|---|---|
| One open conversation per player per match | partial unique index — a double-tapped button can't open two (section 50) |
| One processing per player message | unique `(conversation_id, source_ref)` — `interaction:<id>` or `message:<id>`; storing the player's message *is* the claim |
| Max 5 player messages, then wrap up | `MAX_PLAYER_TURNS`; the model's `should_follow_up` is one input, not the decision |
| Ends when the player changes their answer | `ATTENDANCE_CHANGED` (a conversation that already matches the *new* answer survives, which is what makes a double-click harmless) |
| Ends when the match is cancelled/started/completed | `MATCH_CLOSED` |
| Ends after 12 h idle | `IDLE_TIMEOUT` (`CONVERSATION_IDLE_TIMEOUT_MS`) |
| Only the conversation's own player can post into it | ownership check (section 44 rule 3); a wrong or missing id gets the same answer |
| Respects "AI follow-ups" (section 9) | off → the player gets Phase 6's single message instead of a DM; turning it off mid-conversation ends it |
| Respects "Personal references" | on/off changes how the prompt tells the model to treat what the player shares |

**Failure handling (sections 48/49/66 #8):**

- DMs closed / Discord error → conversation ends `DM_UNAVAILABLE`, the player
  gets the single ephemeral message plus a one-line note. Attendance untouched.
- LLM down at the *start* → the conversation still opens, using section 20's
  own opener wording. LLM down or output rejected *mid*-conversation → a
  short safe wrap-up and the conversation ends (`AI_FAILURE`).
- A reply that fails to deliver leaves the Reply button in place and the
  transcript unchanged (assistant messages are stored only after Discord
  confirms delivery), so the player can just try again.

**Privacy (sections 44, 51, 55, 56):** conversations live only in the
database and the player's DM; nothing personal is ever written to the public
channel. The transcript goes into the prompt inside `<application_data>` as
untrusted data, sanitized like every other field; the CONSOLE conversation
has its own rule block rather than reusing Phase 6's shared rules. Logs carry
metadata only (ids, turn kind, latency, tokens, `memoryCount: 0`) — a test
asserts neither the player's nor the model's text ever appears in them.

**Modal detail:** text inputs are wrapped in a `Label` component, because
Discord deprecated action-row-wrapped inputs in modals; the submit parser
accepts both shapes.

**No new slash commands and no new env vars.** After deploying: run
`npm run db:migrate`. To enable typed replies, add a second external cron job
(same header as the reminders job): `GET https://<deployment>/api/cron/dm-replies`
every 1–5 minutes. Cost note: unlike the reminders tick, this one is only
worth its database wake-up while conversations are open, so if you don't care
about typed replies, don't schedule it — the Reply button never needs it.

**Not verified from this sandbox** (no route to Discord): that Discord
delivers component and modal interactions from a *bot DM* to the Interactions
Endpoint the way it does for guild messages (this is Discord's documented
behavior for apps that DM users they share a server with), and the exact
2000-char/45-char limits are taken from Discord's docs/types rather than a
live call. Both are worth one manual pass in your test server: click "Want to
play, but can't", tap **Reply**, answer, and type one message with the poll
scheduled.

**329 tests passing** (up from 180 at the end of Phase 5's notes): 223 unit,
106 integration against a real Postgres. Three things worth knowing the tests
pin down: (1) a double-tapped button must not end the conversation its twin
just opened (mode-aware `endForAttendanceChange`); (2) the poller must never
move its cursor past a message it hasn't read, or anything the player types
while the model is thinking is silently lost — both were mutation-checked
(deliberately breaking the code makes the tests fail); (3) one Phase 6 test
(`aiContextBuilder.test.ts`) was already failing before this phase because it
still asserted CONSOLE prompt wording that had since been edited; it now
asserts what the code actually guarantees.

### Two decisions locked in for later phases

Neither of these is Phase 4 work — both came up while scoping the cron
migration and were resolved (checked against the plan, not just assumed)
before Phase 4 code was written, so they don't get revisited by surprise
later.

**1. Talking to the bot directly will be a slash command, not `@mention`
parsing.** Discord has no push mechanism for arbitrary channel messages
outside Interactions (commands/buttons/modals) — catching `@Mari hello`
as it happens needs a live Gateway WebSocket, which is exactly the
persistent-process pattern plan section 4 rules out ("VPS
infrastructure") and section 6 says to avoid. A `/mari` (or `/ai`) slash
command gets the same "talk to it directly" behavior through the HTTP
Interactions endpoint this app already has — plan section 63's own Future
Extensions list names exactly this ("`/ai` — Allow players to directly
talk to the team AI"). **Not built yet** — player context now exists
(Phase 5), but it still needs an AI service (`LLM_API_KEY`, Phase 6) to
be worth anything; this only fixes *which* trigger mechanism it'll use
once that exists.

**2. Phase 8's passive message-listening will be replaced by cron-based
REST polling of allow-listed channels, not a gateway connection —** but
with one open question carried forward rather than silently decided.
Discord's `GET /channels/{id}/messages?after=...` works from a stateless
function (needs `Message Content Intent` enabled in the Developer
Portal — an app-level toggle, not a live session) the same way the
reminders cron job already works, tracking a `last_processed_message_id`
per channel for idempotent incremental fetches. Section 6's own
"scheduled/cron execution" covers this the same way it covers reminders.
**What's still open:** this "Hosting & Deployment" section already
flagged, before this conversation, that an *explicit* slash-command
"remember this" flow might fit the plan's own emphasis on consent
(sections 21, 47) better than scanning-then-extracting messages passively
— section 21's whole "Should I remember this? [Remember] [Don't
Remember]" flow is consent-first by design, and section 47's "prevent
false memories" posture leans the same way. Polling solves the
*transport* problem (how do you read messages at all without a gateway);
it doesn't settle *whether* passive scanning is still the right design
once Phase 8 actually starts. Recorded here so that choice gets made
deliberately then, not defaulted into now.

## A dependency vulnerability found and fixed (Phase 2)

`npm audit` flagged a **high-severity SQL-injection advisory in
drizzle-orm** (CVE-2026-39356, fixed in 0.45.2). Checked whether it
actually applied here: the vector requires passing untrusted input to
`sql.identifier()`/`.as()` to build dynamic SQL identifiers, which this
codebase never does — everything goes through the typed query builder. Not
currently exploitable, but upgraded `drizzle-orm` (0.36→0.45) and
`drizzle-kit` (0.30→0.31) anyway since the codebase is still small enough
that a breaking-change upgrade is cheap. `npm audit --omit=dev` (i.e. what
actually ships) reports **zero vulnerabilities**. The remaining findings
under `npm audit` are all transitive dev-only tooling (vitest/vite/esbuild,
pulled in by `drizzle-kit`'s internal config loader) that never ships in
`npm run build && npm start` — not addressed, since the fix (`vitest@5`)
is itself a breaking change with no production benefit.

One side effect worth knowing: drizzle-orm 0.45.x changed how it surfaces
database errors — the top-level `Error.message` is now a generic `"Failed
query: ..."`; the actual Postgres error (constraint name, error code) is
on `err.cause`. Both `dispatchCommand` and `dispatchButton`'s error
logging capture both.

## Timezone discrepancy in plan section 3 — resolved

> "Use `Europe/frankfurt` as the team's default timezone."

**`Europe/Frankfurt` is not a valid IANA timezone identifier.** Germany has
exactly one IANA zone: `Europe/Berlin`. There is no separate Frankfurt zone
in the tz database, so any timezone library (including JS's own `Intl`)
rejects it outright.

Rather than hardcode a string that would throw at runtime the first time
someone tried to compute a reminder time (plan section 13, section 60
explicitly lists "timezone conversion" as a unit-test target), I:

- Built `isValidTimeZone()` (`src/discord/timezone.ts`) and wired it into
  `/setup` so an admin who tries to set it to `Europe/Frankfurt` gets a
  clear rejection instead of a silently broken config
- Added a unit test (`tests/unit/timezone.test.ts`) pinning this down so it
  can't regress

**Resolved at the start of Phase 4** (reminder timing needed a real
answer, not just a valid one): `DEFAULT_TIMEZONE` defaults to
**`Africa/Cairo`** (`.env.example`, `database/schema/serverConfig.ts`) —
plan section 11's own worked example already uses it, and the team is
Cairo-based. Still overridable per-guild via `/setup` if that's ever
wrong for a given deployment.

## Hosting & Deployment: serverless (Vercel + Neon), by design

This app targets **free-tier serverless hosting**: Vercel Functions +
Neon (managed Postgres) + an external scheduler for cron (cron-job.org or
Upstash QStash — Vercel's own free-tier cron only fires once a day, too
coarse for reminders spaced hours/minutes apart, per plan section 13).
This is a direct, deliberate reading of plan section 6 ("serverless
backend execution... managed database... scheduled/cron execution... free
or very low-cost tiers where practical," VPS infrastructure specifically
excluded).

**The one real consequence:** Vercel Functions are stateless and
short-lived — they cannot hold `discord.js`'s gateway `Client` (a
persistent WebSocket) open between invocations. So this app talks to
Discord via **HTTP Interactions** instead: Discord POSTs each
command/button interaction to one endpoint (`api/interactions.ts`), the
app cryptographically verifies it came from Discord
(`src/discord/verifyInteraction.ts`, Ed25519 — this is now the literal
front door of the app, since there's no gateway session implicitly
authenticating anything), and responds. All outbound calls (sending or
editing a message) go through plain REST (`src/discord/discordRest.ts`)
instead of gateway Client methods.

Two things worth knowing if you're picking this up fresh:

1. **Deferred responses.** Discord expects a response within 3 seconds,
   but a cold Vercel function + a cold Neon connection could occasionally
   exceed that. So every command/button interaction is acknowledged
   immediately with a "deferred" response (near-instant, no DB touched
   yet), and the real content is delivered a moment later via a separate
   outbound REST call once the actual work (DB read/write) finishes — see
   `src/discord/handleDiscordInteraction.ts`'s doc comment for the exact
   mechanics of how a single Vercel invocation sends that first response
   and then keeps running to deliver the second one.
2. **This breaks Phase 8's passive message-listening** (plan section 45)
   — an HTTP Interactions endpoint only ever receives interactions
   (commands/buttons/modals), never regular channel messages, which
   requires a gateway connection. Not a blocker now (Phase 8 is several
   phases away); the replacement approach (cron-based REST polling) is
   now decided — see "Two decisions locked in for later phases" under the
   Phase 4 section above for the mechanism and the one open question it
   deliberately leaves for Phase 8 itself.

**Neon needs no code changes.** Use Neon's *pooled* connection string
(the one with `-pooler` in the hostname — PgBouncer, transaction mode) as
`DATABASE_URL`. That's the standard pattern for many short-lived
serverless connections against one Postgres instance, and our existing
`pg` + `drizzle-orm/node-postgres` setup works against it unmodified.

**One caveat I can't verify from this sandbox:** the exact mechanics of
"Vercel keeps a Node.js function invocation alive after its first
response until the handler's promise resolves" (needed for the deferred
→ followup pattern above), and current `maxDuration` limits per plan
tier, are standard/documented Vercel behavior as of this writing, but
this sandbox has no network access to Vercel to confirm live. Worth a
quick check against Vercel's current docs before your first real deploy —
`vercel.json`'s `maxDuration: 15` (interactions) and `30` (the reminders
cron function, which may process several matches' worth of sequential
Discord calls per tick) are reasonable starting points, not
verified-working numbers.

## Architecture decisions made (plan left these open)

The plan explicitly defers some choices ("exact provider should be
selected after evaluating...", "ORM/DB library unspecified beyond
'Prefer PostgreSQL'"). Decisions made so far, all reversible:

| Decision | Choice | Why |
|---|---|---|
| Language/runtime | Node.js + TypeScript (plan section 7, explicit) | — |
| ORM | Drizzle ORM + `pg` | Lightweight, fits the plan's explicit `database/repositories/` pattern better than a heavier client; works unmodified against Neon's pooled connection string |
| Hosting | Vercel Functions + Neon + external cron | Free-tier serverless, per plan section 6 and an explicit cost constraint — see "Hosting & Deployment" above |
| Discord transport | HTTP Interactions (verified via Ed25519), not gateway | Required by the serverless hosting choice — a persistent WebSocket can't survive between stateless function invocations. See "Hosting & Deployment" above for the Phase 8 consequence |
| Command scope | Guild commands, not global | Plan section 54: single-server only, and guild commands update instantly instead of taking up to an hour to propagate |
| Validation | `zod` for env vars and (later) AI structured output | Matches plan section 36/60's emphasis on validating structured data before trusting it |
| Logging | `pino` | Structured JSON by default (plan section 51), pretty-printed only in dev |
| Date/time parsing | `luxon` | Native JS `Date`/`Intl` can't construct a wall-clock time in an arbitrary IANA zone; needed for section 11's "team's configured timezone" and section 60's "timezone conversion" test target |
| Attendance identity | Raw Discord id + display-name snapshot, no `players` FK | Forward-compatible on purpose (design principle #12) — `players` now exists (Phase 5) and `rosterMessage.ts` joins on `discord_user_id`, but `attendance` rows themselves were never touched, exactly as planned |
| Player profile lists | `jsonb` string arrays (`agents`, `protected_topics`), not child tables | Plan section 54/design principle #11: a 6-7 person team has no feature that needs to query *across* agents or topics relationally — see `schema/players.ts` |
| Player removal | Soft delete (`active` flag), no hard `DELETE` | Same pattern as `matches`' `CANCELLED` status; keeps profile/history intact and `/add-player` can reactivate instead of erroring on the unique index |
| Match posting trigger | Provisional `/post-match` admin command | Reminder system (Phase 4) doesn't exist yet — see "ordering tensions" in the Phase 3 section above |
| Reminder generation | Reconcile-on-every-tick, not create-once-at-match-time | Self-healing (a crashed tick or an edited match time just gets fixed by the next tick) instead of needing MatchService to know reminders exist at all — see "Phase 4 — how reminders actually run" above |
| Cron trigger auth | Bearer token (`CRON_SECRET`) checked in `services/scheduling/cronAuth.ts` | Discord's Ed25519 verification only covers Discord's own requests; a cron endpoint needs its own auth or the URL alone is enough to trigger it |
| Reminder idempotency | Claim-then-send (`PENDING` → `CLAIMED` → `SENT`/back to `PENDING`) | A single `UPDATE ... WHERE status='PENDING'` is the actual duplicate-send guard (plan section 50); status alone (`PENDING`/`SENT`) can't tell two concurrent cron ticks apart, an extra transient state can |

## Project layout

Matches plan section 7, plus a top-level `api/` for the Vercel functions
(a Vercel convention, not a plan-derived choice):

```
api/
├── interactions.ts   # Vercel function — the Discord Interactions Endpoint URL
└── cron/
    ├── reminders.ts    # Vercel function — external-cron entry point (Phase 4)
    └── dm-replies.ts   # Vercel function — optional typed-DM-reply poller (Phase 7)

src/
├── discord/
│   ├── commands/      # setup, createMatch, editMatch, cancelMatch, listMatches, postMatch, addPlayer, editPlayer, removePlayer, player
│   ├── interactions/  # dispatchCommand, dispatchButton
│   ├── discordRest.ts, verifyInteraction.ts, httpInteractionAdapter.ts, handleDiscordInteraction.ts
│   ├── permissions.ts, commandGuards.ts, displayName.ts, announcementSync.ts, timezone.ts
│   ├── consoleConversation.ts   # Phase 7: DM opener, Reply modal, reply delivery
├── modules/
│   ├── matches/     # matchService, matchLifecycle, dateTime
│   ├── attendance/  # attendanceService, rosterMessage, customId
│   ├── reminders/   # reminderScheduling (pure planning), reminderMessages (nudge text)
│   ├── players/     # playerValidation (agent/topic parsing, role choices) — Phase 5
│   ├── ai/          # aiService, aiContextBuilder, aiOutput, aiMode (Phase 6); conversationService, conversationContextBuilder, conversationCustomId (Phase 7)
│   └── memories/    # empty until Phase 8
├── database/{schema,repositories}/   # schema: serverConfig, matches, attendance, reminders, players, aiConversations
├── services/
│   ├── scheduling/   # cronAuth, reminderCronJob (Phase 4), dmReplyPollJob (Phase 7)
│   ├── ai/           # llmClient (Phase 6)
│   └── {discord,retrieval}/   # empty until their phase
├── scripts/          # deployCommands, validateCommands
└── config/           # env.ts, logger.ts
```

There's no `src/index.ts` — `api/interactions.ts` is the production
entry point (a Vercel Function has no separate "start the process" step).

## Setup

```bash
npm install
cp .env.example .env
# fill in DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID,
# DISCORD_PUBLIC_KEY, DATABASE_URL, CRON_SECRET (Phase 4 — any long random string)

npm run db:generate   # only needed after changing schema files
npm run db:migrate    # applies drizzle/ migrations to DATABASE_URL
npm run deploy-commands   # registers all slash commands with your test guild
npm run validate-commands # offline sanity check of command definitions (no network needed)
npm run dev               # runs `vercel dev` — local Vercel function emulation
```

Deploy with the Vercel CLI or by connecting the repo in the Vercel
dashboard — no separate build step to run yourself; Vercel builds
`api/interactions.ts` and `api/cron/reminders.ts` directly. After
deploying, set the Vercel deployment's URL + `/api/interactions` as the
**Interactions Endpoint URL** in the Discord Developer Portal (Discord
will immediately send a PING to verify it — see
`handleDiscordInteraction.ts`).

### Discord application setup (one-time, outside this repo)

1. Create an application at the Discord Developer Portal, add a Bot user.
2. Copy the bot token → `DISCORD_BOT_TOKEN`; the application (client) ID →
   `DISCORD_CLIENT_ID`; the **public key** (General Information tab) →
   `DISCORD_PUBLIC_KEY`.
3. Invite the bot to your server with the `applications.commands` and
   `bot` scopes, granting **Send Messages**, **Embed Links**, and **Read
   Message History** in whatever channel you'll set as the match channel.
4. Copy your server's ID → `DISCORD_GUILD_ID`.
5. Set the **Interactions Endpoint URL** (General Information tab) to
   your deployed `.../api/interactions` URL — required for an HTTP
   Interactions app; without it Discord will never deliver any
   interaction to this bot.
6. Run `/setup` first, with a `match_channel` — every match command
   requires the config row it creates, and `/post-match` specifically
   needs `match_channel` set.

### Cron setup (Phase 4, one-time, outside this repo)

Vercel's own free-tier cron only fires once a day — too coarse for
minutes-apart reminders — so an **external** scheduler drives
`/api/cron/reminders` instead:

1. Generate a long random value for `CRON_SECRET` (e.g. `openssl rand
   -hex 32`) and set it in your Vercel project's environment variables.
2. In [cron-job.org](https://cron-job.org) (or Upstash QStash, or any
   scheduler that can set a custom header), create a job:
   - URL: `https://<your-deployment>.vercel.app/api/cron/reminders`
   - Method: `GET` (or `POST` — both work)
   - Header: `Authorization: Bearer <CRON_SECRET>`
   - Schedule: every 5–15 minutes — plenty of granularity for a 6–7
     person team's reminder offsets
3. A request with a missing/wrong header gets `401`; a healthy tick
   returns `200` with a small JSON summary
   (`{ok, guildsProcessed, matchesReconciled, remindersSent, ...}`) —
   useful for confirming it's actually running from the scheduler's own
   request-history view.

## Testing

Mirrors plan section 60's split between unit and integration tests:

```bash
npm test               # unit tests only — no infrastructure needed (223 tests)
npm run test:integration  # requires DATABASE_URL pointing at a disposable
                           # Postgres with migrations applied (106 tests)
```

Every `tests/integration/*.test.ts` file self-skips (rather than failing)
when `DATABASE_URL` isn't set, so `npm test` stays fast and infra-free by
default while CI (or you, locally) can opt into the full suite by setting
`DATABASE_URL` and running `npm run test:integration`.

The integration suite includes full command-path tests — a real (mocked
Discord-interaction-object, real database) call through
`dispatchCommand`/`dispatchButton` → the actual handler → the actual
repository → Postgres — for every command and the button flow, including
a fake `DiscordRestClient` (`tests/integration/phase3E2E.test.ts`) that
tracks its own edited message content, so "does `/cancel-match` actually
remove the buttons from the live message" is a real assertion, not an
assumption.

Since the hosting migration, there's a second, even deeper tier:
`tests/integration/httpInteractionE2E.test.ts` exercises the *entire* HTTP
Interactions flow — a **real Ed25519 keypair** signs a request exactly the
way Discord does, `handleDiscordInteraction` verifies it cryptographically
(`tests/unit/verifyInteraction.test.ts` covers the verification function
itself in isolation, including tampered-payload and wrong-key rejection),
sends the deferred ack, dispatches through the real command/button
handlers, and delivers the real content via the real followup REST call —
all against a real Postgres database. This is the deepest verification
possible without live Discord/Vercel network access, which this sandbox
doesn't have (`discord.com` and `vercel.com` aren't in its egress
allowlist); a real deploy + a real Discord server is the one step that
still needs to happen on your end.

What's covered so far, mapped to plan section 60's checklist:
- ✅ Permission checks (`tests/unit/permissions.test.ts`,
  `tests/unit/checkAdminFromInteraction.test.ts`)
- ✅ Timezone conversion (`tests/unit/timezone.test.ts`,
  `tests/unit/dateTime.test.ts` — including DST transitions and leap years)
- ✅ Match state transitions (`tests/unit/matchLifecycle.test.ts`, every
  status × both guards)
- ✅ Attendance state changes — idempotent upsert, per-match scoping, FK
  cascade (`tests/integration/attendanceRepository.test.ts`); a click
  rejected on a closed match, and a second click from the same player
  updating (not duplicating) their response
  (`tests/integration/phase3E2E.test.ts`)
- ✅ Player profile CRUD — create/read/partial-update, soft-delete +
  reactivate-on-re-add, one-profile-per-guild-per-user uniqueness
  (`tests/integration/playerRepository.test.ts`); role/agent/protected-topic
  input validation and the User-option adapter resolution
  (`tests/unit/playerValidation.test.ts`,
  `tests/unit/httpInteractionAdapter.test.ts`)
- ⬜ Protected-topic *filtering into an AI context*: N/A yet — the topics
  are now captured and storable (`/edit-player`), but there's no AI
  context builder to filter them out of until Phase 8/9
- ✅ `server_config` / `matches` / `attendance` / `reminders` / `players`
  repository semantics, including database-level constraints (unique
  indexes, FK cascade) (`tests/integration/serverConfigRepository.test.ts`,
  `tests/integration/matchRepository.test.ts`,
  `tests/integration/attendanceRepository.test.ts`,
  `tests/integration/reminderRepository.test.ts`,
  `tests/integration/playerRepository.test.ts`)
- ✅ Full command-path integration tests (real interaction → dispatch →
  repository → Postgres) for every Phase 1-4 command and the button flow
  (`tests/integration/setupCommandE2E.test.ts`,
  `tests/integration/matchCommandsE2E.test.ts`,
  `tests/integration/phase3E2E.test.ts`)
- ⬜ Same command-path depth for `/add-player` / `/edit-player` /
  `/remove-player` / `/player`: not written yet. What Phase 5 does have is
  full repository-level integration coverage (above) plus unit coverage of
  each command's own validation logic and option parsing — the gap is
  specifically an E2E test exercising `dispatchCommand` → the real handler
  → Postgres for these four, the way `phase3E2E.test.ts` does for
  attendance. Flagging this honestly rather than implying it's covered.
- ✅ HTTP Interactions signature verification and the full real-signature →
  defer → dispatch → followup flow (`tests/unit/verifyInteraction.test.ts`,
  `tests/integration/httpInteractionE2E.test.ts`)
- ✅ Reminder scheduling (plan section 13/60): offset math incl. a DST
  transition (`tests/unit/reminderScheduling.test.ts`), claim-based
  duplicate-send prevention under concurrent claims, reconcile idempotency,
  cancelled-match cleanup (`tests/integration/reminderRepository.test.ts`),
  and the full cron-tick flow — announcement vs. nudge routing, same-tick
  multi-offset ordering, a reverted-then-retried failed send
  (`tests/integration/phase4E2E.test.ts`)
- ⬜ Memory visibility, protected-topic filtering, AI output validation —
  depend on tables/features that don't exist until later phases; will be
  added alongside each phase, not retrofitted at the end

**Phase 4's integration suite was actually run**, not just written: this
sandbox has no route to Neon, so I installed Postgres locally
(`apt-get install postgresql`), ran the real `drizzle/` migrations
against it, and executed all 151 tests for real — that's how the
same-tick stale-snapshot bug mentioned above got caught before you would
have hit it, rather than being a theoretical gap in coverage.

## Roadmap (plan section 59)

- [x] Phase 1 — Discord Foundation
- [x] Phase 2 — Match System (`/create-match`, `/edit-match`,
      `/cancel-match`, `/list-matches`, match lifecycle)
- [x] Phase 3 — Attendance (buttons, public roster message, `/post-match`
      as a provisional bridge until Phase 4)
- [x] Phase 4 — Scheduling (reminder reconciliation, claim-based
      idempotency, DST-safe offset math) — absorbed `/post-match`'s
      manual trigger into an automatic one (kept as a manual override);
      runs via external cron (`api/cron/reminders.ts`) since the
      serverless transport has no persistent scheduler of its own
- [x] Phase 5 — Player Profiles (`/add-player`, `/edit-player`,
      `/remove-player`, `/player`; roles, agents, AI settings, protected
      topics) — also resolved the two Phase 3 roster-message ordering
      tensions (real "No response" section, real `Confirmed: X/Y`)
- [x] Phase 6 — Basic AI (CELEBRATE / ROAST / CONSOLE, no memory yet)
- [x] Phase 7 — Private AI Conversations (CONSOLE DM flow: Reply-button modal +
      optional typed-reply poller, follow-ups, turn/idle/match-state limits)
- [ ] Phase 8 — Memory System
- [ ] Phase 9 — Retrieval (structured + semantic + privacy filtering)
- [ ] Phase 10 — Match Hype / Recaps

Each phase will be checked against `Full_Development_Plan.md` before
implementation, per the ground rule for this project.
