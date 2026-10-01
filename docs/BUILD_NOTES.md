# Valorant Premier Discord AI Assistant

Private Discord bot for a 6–7 person Valorant Premier team. See
`Full_Development_Plan.md` (included alongside this repo) — that file is
the single source of truth for scope and behavior; this README only covers
how to run what's built so far and the decisions made while building it.

## Status: 2026-09-29 — DM chat / server chat + gateway worker ✅ (Phases 1–10 also complete)

Newest work: [2026-09-29 — Mari as a real chat](#2026-09-29--mari-as-a-real-chat-dm--server-split-gateway-worker)
(below the Phase 10 notes).

Jump to [Phase 10 — hype & recaps](#phase-10--match-hype--recaps-what-was-built-and-the-choices-made)
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
- **Memory is Phase 8.** `memory_candidate` is accepted and discarded
  exactly like Phase 6, and the prompt forbids the model from offering to
  "remember" anything. The `[Remember]/[Don't Remember]` buttons from
  section 61's example belong to Phase 8 (section 21), so they aren't here.
  (Update from Phase 8: this is exactly what got built — see below.)

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
2. **Typed replies, via an optional cron poll** (`api/cron/dm-replies.ts`).
   Not instant, and only works once you schedule it. A burst of typed
   messages is joined into one turn. (Phase 8 note: this cron-polling
   design was once assumed to extend to scanning whole channels for
   memorable content too — see the resolved item below for why that
   turned out not to be the right call.)

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

**2. Resolved in Phase 8: passive message-listening was NOT built — see the
"Section 59's raw message storage" note in the Phase 8 section below for the
full reasoning.** The question below is preserved as it was written during
Phase 7, since the reasoning that led to the opposite conclusion is worth
keeping visible rather than quietly edited away.

~~Phase 8's passive message-listening will be replaced by cron-based
REST polling of allow-listed channels, not a gateway connection —~~ but
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

### Phase 8 — Memory System: what was built and the choices made

Plan section 59 scope: *raw message storage, AI conversation storage, memory
table, memory evidence, memory visibility, memory approval.* AI conversation
storage was already Phase 7's `ai_conversations`/`ai_messages`. That leaves
four things, plus one the plan doesn't scope to any single phase but groups
under the same theme: sections 42/43's `/memories` player command.

- **`memories` / `memory_evidence`** (migration `0006_add_memories.sql`) —
  section 23's schema and section 25's evidence table, field-for-field: the
  nine categories from section 22 as a fixed enum (`memory_type`), the four
  visibility levels from section 24 (`memory_visibility`), `confidence` /
  `importance` / `ai_usable` / `last_used_at` all present per section 23 even
  though only `confidence` has a real writer yet (see below). `playerId` is a
  real FK to `players.id` — `players.ts`'s own Phase-5-era comment guessed
  this table would key off `discord_user_id` instead; Phase 7's
  `ai_conversations.player_id` already set the actual precedent (an FK,
  because players are soft-deleted, never dropped), and this follows it.

- **Memory creation is auto-save with after-the-fact control (section 21,
  revised 2026-09-26 — see the plan's own changelog note there), and only
  ever happens inside a CONSOLE conversation.** CELEBRATE and ROAST have no
  free-text player input to draw a fact from at all — the player never types
  anything in those flows, just clicks a button — so there's structurally
  nothing for a memory candidate to come from outside a conversation. A
  candidate rides on the same `ai_messages` row that proposed it (two
  columns, `memory_candidate` and `memory_candidate_status`), rather than a
  separate staging table: that row already *is* the evidence (section 25's
  own example — "AI conversation #52") for whichever memory it becomes.
  `aiOutput.ts` validates the candidate's shape and drops (not rejects) it
  outright if `requires_confirmation` isn't literally `true` or its content
  touches a forbidden topic — the response text next to it still goes
  through either way (section 37: the model only ever *suggests*, so a bad
  suggestion shouldn't sink a good reply).

- **The prompt can only propose a memory when wrapping up, and only when
  the player's own "Memory usage" setting (section 9) allows it** — signaled
  as a data line (`Memory usage: disabled`) exactly the way
  `valorantReferencesEnabled`/`personalReferencesEnabled` already are, not as
  a different system prompt. Consent lives entirely in that one setting
  (section 21's revision: expressed once, up front, not per fact) — there is
  no button gating an individual candidate. `aiService.ts` drops the
  candidate again regardless of what the model does when the setting is
  off, `aiOutput.ts` has already dropped anything malformed or
  forbidden-topic, and `consoleConversation.ts` itself only ever acts on a
  candidate when `!outcome.continues` (section 37: the backend enforces
  "only on a wrap-up turn," not just the prompt's cooperation).

- **Auto-saved via a follow-up edit, with a single Forget button.**
  `MemoryService.autoSave` needs the `ai_messages` row's own id, which only
  exists once persisted — so the DM goes out first (keeping Phase 7's
  invariant that a message is only ever recorded after Discord confirms
  delivery), the memory gets created, then one follow-up `editChannelMessage`
  call appends a short "Noted — I'll remember that" note and a single 🗑️
  Forget button using the *real memory's* id. A continuing conversation's
  Reply button and a wrap-up's Forget button are mutually exclusive by
  construction (a candidate can only be non-null when `!continues`), so a
  message never needs both.

- **Saving is a single atomic claim, not a read-then-write** — `UPDATE
  ai_messages SET memory_candidate_status = 'APPROVED' WHERE ... =
  'PENDING'`, the same shape `reminders.status` already uses (section 50: a
  retried delivery can't create two memories from the same candidate).
  `PENDING`/`DECLINED` are otherwise vestigial now — nothing decides
  anything anymore, the backend just claims-and-saves in one step.

- **`/memories`, and the DM's Forget button, are the exact same delete path**
  (sections 42/43) — self-service, no admin gate, categorized by the section
  22 types in the list, one 🗑️ button per entry there and one on a
  fresh auto-save note. `MemoryService.deleteOwn` resolves ownership from
  the memory's own `playerId` rather than `(guildId, discordUserId)` — a DM
  interaction has no `guildId` at all — so the identical `memory:del:<id>`
  handler works from a guild channel or a DM alike (section 44 rule 4: a
  guessed id can't touch someone else's memory, and "not yours" and
  "doesn't exist" look identical to the caller either way). Deletion
  cascades to that memory's evidence rows. This is the plan's own named
  alternative to a separate `/memory-delete <id>` command ("or an
  interactive memory-management flow") — chosen because a player should
  never have to know or type a raw memory id to forget something about
  themselves.

**Confidence and importance, honestly scoped.** Section 26 describes
confidence rising with repeated evidence; Phase 8 has exactly one way a
memory gets created — an explicit, in-conversation statement — so confidence
is always `1.0` (section 61's own example). Nothing here re-derives or bumps
confidence from a second, similar mention; that needs comparing a new
candidate against existing memories, which is retrieval territory (section
33's ranking formula, Phase 9 — see below). `importance` defaults to `50`
(the same "normal" midpoint `roastIntensity` uses) and, as of Phase 8, was
otherwise inert; Phase 9's ranking formula is the first thing that reads it.

**Section 59's "raw message storage" — deliberately not built, and why.**
The "Two decisions locked in for later phases" note above (written during
Phase 7) flagged this exact question and left it open on purpose: passive
scanning of `#valorant`/`#premier`/`#general` for memorable content
(sections 27/28/45/46) needs its own infrastructure surface — Message
Content Intent, a channel allow-list, a cron job, a *second* LLM call just
for extraction (section 46) — separate from anything the consent-first flow
above needs. `schema/index.ts`'s own Phase-5-era "still to come" comment
already only ever named two new files for Phase 8 (`memories.ts`,
`memoryEvidence.ts`) — no raw-messages table — which matches the conclusion
reached independently here: sections 21 and 47 both point toward
consent-first (an explicit ask beats mining chat for facts), and a 6-7
person team generates approval-worthy moments mostly through the CONSOLE
conversations that already exist, not through incidental chatter in
`#general`. If usage ever shows the CONSOLE-only path isn't producing enough
memories, passive scanning is still exactly the escape hatch the plan
describes — it just isn't built speculatively now (design principle #11).

**Privacy (section 44):** all four rules that apply so far hold — private
conversations never leak their contents to the public channel (unchanged
from Phase 7); a memory's visibility defaults to `PRIVATE` (section 21:
"default visibility should be conservative") and nothing in this codebase
writes `TEAM`, `PUBLIC` or `PROTECTED` yet — Phase 9's retrieval/filtering
logic is written to respect all four values (`PROTECTED` specifically
exists as a value the *filtering* side can check for, not one anything
produces), but doesn't add a writer for the other three either; see the
Phase 9 notes below for the concrete consequence of that; `/memories` and
every delete only ever resolve against the caller's own player row; and a
forbidden or
nonexistent candidate id gets an identical reply either way.

**Not verified from this sandbox** (no route to Discord): that
`editChannelMessage`'s two-step send-then-edit actually renders as a single
clean update in a real Discord client for a DM message specifically (versus
a guild channel, which is where every other `editChannelMessage` caller in
this codebase uses it), and that a `🗑️`-emoji `ButtonStyle.Danger` button
labeled with a bare number reads clearly on mobile. Both are worth a manual
pass alongside Phase 7's own pending manual checks.

**Test coverage (revised 2026-09-26 alongside the section 21 consent-model
change and Phase 9):** `aiOutput.test.ts`'s candidate validation (every
section 22 category, the `requires_confirmation` shape gate, the
forbidden-topic drop); `memoryRepository.test.ts` for evidence-cascade,
per-player deletion scoping, and `touchLastUsed`; and
`phase8MemoryE2E.test.ts`, a full Postgres-backed run through
propose → auto-save → Forget-button delete → double-delete idempotency →
cross-player rejection → `memoryUsageEnabled: false` → `/memories` →
delete. (The original Remember/Don't Remember button flow's own coverage,
including `memoryCustomId.test.ts`, was removed along with that code —
see the section 21 revision above.)

## Phase 9 — Retrieval: what was built and the choices made

Per plan section 59, Phase 9 is: structured retrieval, semantic retrieval,
ranking, privacy filtering, context builder — "only now should the AI
become deeply personalized." Built: everything except semantic retrieval
(design principle #11 — a 6-7 person team with a consent-first,
in-conversation-only memory writer will have a handful of memories per
player, not a corpus that needs an embedding index; section 32 itself
says embeddings "may be introduced," not must). New module:
`src/modules/memories/memoryRetrieval.ts`.

**The pipeline, plan section 30 minus its semantic-retrieval step:**
`AiService` fetches a player's memories (`MemoryRepository.listByPlayer`
— already existed for `/memories`, reused rather than duplicated),
`retrieveMemories` filters for eligibility, scores what's left, and
returns the top few; `aiContextBuilder.ts`/`conversationContextBuilder.ts`
render whatever they're handed as a `RELEVANT MEMORIES` block (section
34's own example) — those two files never touch the database or do any
ranking themselves, same split every AI-adjacent piece of this codebase
already keeps.

**Privacy filtering runs before ranking, not after** — section 10's flow
("apply privacy/protection filters" is a step of its own, before "build AI
context"), and there's no reason to rank, then limit, then discard
something that could never have been shown in the first place. Three
gates, all in `isEligible`: `aiUsable`/`PROTECTED` are never eligible
anywhere; forbidden topics are re-checked at *read* time using the exact
matcher `aiOutput.ts` already uses at *write* time (`mentionsForbiddenTopic`,
now exported) — a player who protects a topic after a memory about it was
already saved is protected retroactively, without rewriting the old row;
and — the one genuinely new privacy decision this phase had to make —
**a PRIVATE memory is only ever eligible for the audience it was written
for.** Section 44 rule 1 ("private information should never automatically
become public AI content") reads very differently after the Phase 6 change
that made CELEBRATE/ROAST post publicly in the match channel instead of
staying ephemeral (see that section above): Phase 8's *only* writer always
saves `PRIVATE`, so as implemented, retrieval currently finds **zero**
eligible memories for CELEBRATE/ROAST — every memory that exists right now
is scoped to the player's own private CONSOLE conversation, which is the
only place any of them actually surface today. This is the conservative
outcome given what's been built, not a bug: `isEligible` and its tests are
written against `PUBLIC`/`TEAM` visibility in general, ready for whenever
a future writer produces one (a Phase 10 post-match recap marking a
teamwide `MATCH_EVENT` `TEAM` or `PUBLIC`, say) — Phase 9 doesn't add that
writer itself, only the machinery that will respect it once one exists.

**Ranking (section 33's formula, semantic-similarity term dropped):**
`mode_relevance * 2 + importance + confidence + recency`, each normalized
to `[0, 1]`. `mode_relevance` reuses section 31's own worked lists
verbatim for ROAST (`RUNNING_JOKE`/`VALORANT_PREFERENCE`/`TEAM_JOKE`/
`MATCH_EVENT`) and CONSOLE (`PLAYER_PREFERENCE`/`PERSONALITY_TRAIT`/
recent events, avoiding "aggressive roast material" — `RUNNING_JOKE`/
`TEAM_JOKE` score exactly `0` for CONSOLE, not just lower); CELEBRATE
reuses ROAST's set plus `ACHIEVEMENT`, since section 31 doesn't give it
its own list and it's ROAST's closest sibling (single-shot, banter-
flavored, just the positive side). It's a weighted hybrid, not a hard type
filter, everywhere except that one CONSOLE exclusion: a highly important,
highly confident, very recent memory of a non-preferred type can still
outrank a stale, low-importance preferred one (there's a test for exactly
this). Recency is an exponential decay off `created_at` with a 21-day
half-life — the plan specifies a recency *term*, not its shape, so this is
a starting point tuned by feel, flagged in the code as exactly that kind
of thing (section 33: "implemented and tuned after the basic system
works").

**`last_used_at` (section 23) finally has a writer.** `MemoryRepository.touchLastUsed`
is called (awaited, with any error swallowed — a detached promise can be
frozen or killed on serverless hosting, silently dropping the write) for
whichever memories actually made it into a context — never every memory a player has. Nothing reads it back yet (no
recency-of-*use* tie-breaker layered on top of section 33's recency-of-
*creation* term), but it's real data now instead of permanently `null`.

**Backward compatible by construction, not by special-casing.**
`AiService`'s constructor takes the memory repository as a third,
optional argument (default `null`); every 2-argument call site — every
test written before this phase existed — behaves exactly as it did
before: no repository means retrieval always returns `[]`, the same shape
a player with zero memories produces. `buildAIContext`/
`buildConversationContext` both take memories as an optional param for
the same reason. Nothing about Phase 6/7/8's own behavior changed; Phase 9
is purely additive.

**271 unit / 122 integration tests passing** (up from 258/118 before this
revision + Phase 9). New: `memoryRetrieval.test.ts` (scoring, eligibility,
end-to-end ranking — 18 tests), plus `RELEVANT MEMORIES` rendering
coverage in `aiContextBuilder.test.ts`/`conversationContextBuilder.test.ts`,
retrieval-wiring coverage in `aiService.test.ts` (fetch → retrieve →
prompt → `touchLastUsed`, including the audience/visibility gate with a
real repository fake), a `touchLastUsed` case in
`memoryRepository.test.ts`, and `phase9RetrievalE2E.test.ts` — a
Postgres-backed run proving a `PUBLIC` memory reaches a real public
CELEBRATE post while a `PRIVATE` one for the same player never does,
`last_used_at` is actually persisted, and a CONSOLE DM can use a player's
own `PRIVATE` memories. Not independently re-run against a live database
from the environment this phase was built in — no DB route available
there — so a real `npm run test:integration` pass is worth doing before
treating this phase as fully verified, same caveat as Phase 8's original
notes.

## Phase 10 — Match Hype / Recaps: what was built and the choices made

Plan section 59 scopes this phase as `MATCH_HYPE`, `POST_MATCH`, match
events, and match memories (sections 38, 39, 40).

**Built**

- `/complete-match match_id result:WIN|LOSS [notes]` (admin only) — marks
  the match `COMPLETED`, stores `result`/`notes`/`completed_at` on
  `matches`, turns the admin's freeform notes into structured
  `match_events` rows, posts a recap to the match channel, and refreshes
  the public roster message (its buttons disappear, same as
  `/cancel-match`).
- `match_events` table (section 40): `CLUTCH / MVP / TOP_FRAG /
  FUNNY_MOMENT / ACHIEVEMENT / TEAM_EVENT`. `player_id` is nullable
  (`TEAM_EVENT`, or a name in the notes that isn't on the roster).
- **Match memories**: each player-tied event becomes one `MATCH_EVENT`
  memory at `TEAM` visibility, evidenced back to its `match_events` row
  (`memory_evidence.source_type` gained `MATCH_EVENT`). This is the writer
  the Phase 9 notes said retrieval was waiting for.
- `MATCH_HYPE`: the reminder cron's nudge for the offset closest to
  kickoff (15 minutes in the default 3h/1h/15m schedule) becomes a
  `🔥 15 MINUTES` embed title + AI flavor text on top of the deterministic
  match line (`Match #id — <t:kickoff>`), built from the roster/agents in
  the database (section 38's split: facts from the DB, AI only writes the
  personality layer). Since the 2026-09-27 reminder-UI enhancement this
  is the *same embed* as the plain nudge (coloured border, live Discord
  timestamps, attendance tallies) — hype only swaps the title and adds
  the AI text, it is not a separate message.
- Migration `0008_add_match_events_and_recap.sql` (originally numbered
  `0007`, colliding with `0007_drop_match_opponent`; renumbered on
  2026-09-28 and written idempotently so it is safe on a database that
  already ran the old file).

**Choices the plan left open**

- **Hype trigger.** Section 38 says "optionally" and names no trigger.
  Its example header ("🔥 15 MINUTES") matches the last default reminder,
  so hype rides on that nudge instead of adding a command. Consequences:
  a one-offset schedule never gets hype (its only reminder is the
  announcement, which must carry the buttons), and non-closest nudges are
  unchanged. If the LLM is off or fails, the plain nudge goes out exactly
  as before (principle 8).
- **Team-wide modes stay out of `AiMode`.** `MATCH_HYPE`/`POST_MATCH`
  address the whole roster, have no attendance status, and don't fit
  `ai_conversations` (player+match scoped), so they have their own context
  builders (`teamAiContextBuilder.ts`) and output validator
  (`parseTeamMessage`) instead of stretching the per-player ones.
- **Protected topics = union across the roster.** A team message can name
  anyone, so its forbidden list is every active player's protected topics
  combined; the same list also filters the model's output.
- **Facts stay outside the LLM.** The recap's header, match id/kickoff
  and WIN/LOSS line are built by the app; only the body is AI. With AI off or
  failing, a short generic line is posted instead. The `💔` header for a
  loss is my choice; the plan only shows a win example.
- **One LLM, not two.** Section 57 suggests a cheaper model for
  extraction. Only one model is configurable today, so extraction and the
  recap both use it (principle 11). Splitting later is one constructor
  argument.
- **Extraction is conservative.** The model must copy roster names
  exactly; the backend matches them case-insensitively and exactly, no
  fuzzy matching. An unmatched name stores the event with no player and
  creates no memory. A single event that trips a protected topic is
  dropped without failing the rest.
- **Memory rules.** Player-tied events only create a memory if that
  player's `memoryUsageEnabled` is on (section 9). `TEAM` visibility
  (not `PUBLIC`) is the most restrictive level that still lets a team
  performance fact be reused (section 24). Confidence is 1: the admin
  wrote it down.
- **Completion is allowed from any non-terminal status** (nothing in the
  codebase ever sets `IN_PROGRESS`, so in practice: `CONFIRMATION_OPEN`
  or `SCHEDULED`). The match channel is checked before anything is
  written, so a misconfigured guild can't end up `COMPLETED` with no
  recap possible.
- **`ALTER TYPE ... ADD VALUE`** is part of migration 0007. Postgres 12+
  allows it inside the migrator's transaction because the new value isn't
  used in the same migration; on an older server it would fail.

**Verified** (Postgres 16 installed locally in the build sandbox): the
migration applies cleanly; `match_events` FKs behave as designed (cascade
on match delete, set-null on player delete); `/complete-match` end to end
(events, `TEAM` memory + evidence, recap post, roster refresh, blocked
already-completed match, missing match channel, `memoryUsageEnabled=false`,
AI off); hype end to end (closest nudge, non-closest nudge, LLM failure,
AI off, single-offset schedule).

**Not verified / worth knowing**

- I did not test that a Phase 10 `TEAM` memory actually surfaces in a
  later CELEBRATE/ROAST through Phase 9 retrieval. The visibility and
  type are ones retrieval already handles, but that link has no test.
- `/complete-match` can make two sequential LLM calls (extraction, then
  recap), each capped by `LLM_TIMEOUT_MS` (10s default), inside a function
  with `maxDuration: 30`. It fits, with little slack; raise `maxDuration`
  if the provider is slow.
- There is no command to view or delete `match_events` rows themselves;
  memories derived from them are covered by the existing `/memories`
  flow, but I did not check how those `TEAM` memories appear there.
- **Pre-existing problems found, not caused by this phase and not
  fixed:** `npm run typecheck` reports two errors on the code as uploaded
  (`memoryDecision.ts` calls `MemoryService.decide`, which doesn't exist;
  `llmClient.ts` calls `logger.info` on a type that only has
  `warn`/`error`). The first is dead code left over from the original
  opt-in Remember/Don't Remember flow that the 2026-09-26 section 21
  revision replaced with `autoSave`: nothing imports `memoryDecision.ts`
  and `dispatchButton.ts` doesn't route those button IDs, so it can't run.
  (`memoryCustomId.ts` and its unit test are leftovers from the same flow,
  despite the Phase 8 notes saying that test was removed.) Also, 6 tests in the phase 6/7/9
  integration files failed in my run; the same files fail on the untouched
  upload (a different subset on each run), so I'm treating them as
  timing-sensitive, but I did not root-cause them.
- The copy of `Full_Development_Plan.md` in the Claude Project's files is
  older than the one bundled in the zip (sections 21/44/CELEBRATE-ROAST
  revisions). Sections 38-40 and 59, which this phase uses, are identical
  in both.

## 2026-09-28 — three additions beyond the phase plan

Requested directly by the person running the project, each checked against
`Full_Development_Plan.md` first, per this project's own ground rule.

### Looser Date/Time input (plan section 11)

The plan's own example (`Date: 18/09/2026`, `Time: 19:00`) is tried first,
unconditionally, in `dateTime.ts`'s `parseMatchDateTime` — every existing
admin habit and every pre-revision test keeps working byte for byte. Only
when that exact shape doesn't match does either field fall through to a
fixed, documented set of extra forms: `today`/`tomorrow`/`tonight`, a bare
or `next`-prefixed weekday, `in N day(s)`/`in N week(s)`, and D/M/YYYY with
either separator for the date; a named part of day (`morning` 09:00,
`afternoon` 15:00, `evening`/`tonight` 19:00, `night` 21:00, `noon`,
`midnight`), 12h `7pm`/`7:30pm`, or a relative duration (`2 hours`,
`in 90m`, `1h30m` — counted from *now*, so it only combines with
`date: today`) for the time. The two fields can mix strictness freely (an
exact date with a loose time, and vice versa). Free-form NLP was
deliberately left out — design principle #11, start simple — this is a
fixed token set, not a general parser, and the error message says so.

### `/mari` — plan section 63's `/ai`, pulled forward

Section 63 lists `/ai` ("Allow players to directly talk to the team AI")
as a Future Extension explicitly not expected to affect V1's architecture.
It didn't: a `DIRECT_CHAT` conversation is just `matchId: null` (migration
`0009` drops the `NOT NULL`, plus its own partial unique index —
`(guild_id, player_id) WHERE match_id IS NULL AND ended_at IS NULL` — since
a plain unique index treats every NULL as distinct and would happily let
the same player open two "open" direct chats at once). Everything else —
`ConversationService.handlePlayerReply`, the DM/Reply-button modal
transport, turn limits, the memory-candidate auto-save flow — is reused
completely unchanged; it was already written generically enough not to
care what mode a conversation is in. The one new piece per mode is the
context builder: `buildDirectChatContext` (a sibling of CONSOLE's, not a
branch inside it — CONSOLE's rules are entirely about one situation,
section 20's "wants to play but can't", which DIRECT_CHAT has no
equivalent of). Two differences from CONSOLE worth remembering: roast
intensity applies here (CONSOLE deliberately never roasts; free chat
should still banter per the player's own dial), and there's no "opener"
step — the player's own first message goes straight through
`handlePlayerReply` like every later turn, so `respondInConversation`
picks CONSOLE vs DIRECT_CHAT purely by whether a match was given, not a
separate flag that could drift from it.

Named after the bot's own in-character name rather than the plan's literal
`/ai` — every private message elsewhere in this codebase already signs
itself "M.A.R.I.".

### `/add-memory` — manual starter facts about players

Extends plan section 21's memory-creation flow to a case it doesn't cover:
seeding lore the team already has (an existing running joke, a known
preference) at onboarding, instead of waiting for it to resurface in a
conversation Mari happens to be part of. `MemoryService.createFromAdminEntry`
writes confidence `1.0` (section 26: an admin stating a fact is a confirmed
fact, not an inferred guess) with a new `ADMIN_ENTRY` evidence source type
(migration `0009`) whose `sourceId` is the entering admin's own Discord
user id — traceable exactly like every other memory (section 25).
Visibility is the admin's own explicit choice (defaults to `PRIVATE` when
omitted — section 24's "most restrictive reasonable default"); nothing
about *how* a memory was created changes *how* it's later allowed to be
used — retrieval's forbidden-topic filter and the PROTECTED-visibility
rule (section 10) apply to an admin-entered memory exactly like any other,
confirmed end-to-end in `tests/integration/addMemoryE2E.test.ts`.

## 2026-09-29 — Mari as a real chat: DM / server split, gateway worker

Requested by the person running the project. Every change has a matching
revision note in `Full_Development_Plan.md` dated 2026-09-29 (sections 4, 6,
21, 24, 29, 42, 43, 44, 63) — the plan was edited first, code second.

**What changed**

- **Two free-form chats, one lifecycle.** `DIRECT_CHAT` (a DM, private) and
  new `SERVER_CHAT` (public). One builder (`buildChatContext`) serves both;
  they differ in who can read the answer, which changes only which memories
  are eligible, which protected topics apply (a public reply uses the
  *union* of every player's), and a few rule lines.
- **`/mari` answers publicly in the channel it was used in.** `/mari` is
  deferred *publicly* (`shouldDeferPublicly` in `handleDiscordInteraction.ts`,
  decided from the raw payload — a deferral's visibility can't be changed
  later). Errors meant only for the caller stay ephemeral: the adapter swaps
  the public placeholder for a private followup. `/mari private:true` is the
  old DM behaviour, kept as the fallback that needs no gateway worker.
- **Gateway worker** (`worker/gateway.ts`, `npm run worker`): receives typed
  DMs (`ConversationService.routeDmMessage`) and `@Mari` mentions
  (`runServerChatTurn`) instantly. It is a thin shell over the same services
  and database; it holds no state and is optional. See "Gateway worker" below.
- **Memory is silent, on any turn.** The model returns
  `memory_candidates` (0–3) every turn; the backend validates, de-duplicates
  (`isSameFact`, evidence bumped instead of a second row) and saves.
  No "I'll remember that", no Forget button — in DMs, server chats, and
  CONSOLE's wrap-up save alike.
- **Where a memory came from decides its visibility:** DM → `PRIVATE`,
  server → `TEAM`, `/add-memory` default → `PUBLIC` (was `PRIVATE`).
  A server chat therefore can never see a DM-learned fact; a DM chat sees
  everything not `PROTECTED`.
- **Forget by asking.** Only when the message matches `looksLikeForgetRequest`
  does the prompt list the audience-visible memories with ids; the model
  returns `forget_memory_ids`; the backend keeps only ids that were shown,
  then `deleteManyForPlayer` re-checks ownership in SQL. Two independent
  layers, both tested (the second by its own test — a mutation run showed the
  end-to-end test alone did not exercise it).
- **Lifecycle.** Free-form chats close after **5 h idle** (checked on the next
  message) or at a **40-message cap** (`MAX_CHAT_PLAYER_TURNS`). The model
  cannot end them (`should_follow_up` is gone from this contract). A model
  failure mid-chat keeps the chat open ("say that again"), unlike CONSOLE.
  The next message opens a new chat whose prompt has the memory table only —
  never the old transcript (plan section 29). Within a chat only the newest
  24 transcript entries are sent.
- **Server chat also knows the database:** roster, next match + attendance,
  last result + events, and up to 6 teammates' `TEAM`/`PUBLIC` memories
  (`teamFactsService.ts`; design principle #9 — facts from the DB, never the
  model). A DM chat gets the roster/matches but not teammates' memories.
- **Retrieval for chats:** window 4 → 10 memories, plus a crude keyword-overlap
  term against the player's latest message (plan section 33's
  `semantic_similarity` without embeddings — design principle #11).
- **Poller de-duplication:** with both a worker and the cron poller running,
  the poller skips any message whose `message:<id>` is already stored
  (`listStoredSourceRefs`) so nothing is answered twice.
- **`/mari` roster check fixed:** it previously only checked that a player row
  existed, so a soft-removed player got a confusing error. It now requires
  `active` (server chat, `@Mari` and DMs alike).

**Migration `0010_add_server_chat.sql`** — adds the `SERVER_CHAT` enum value and
replaces the one-open-DIRECT_CHAT index with
`ai_conversations_one_open_chat_idx (guild_id, player_id, mode)`, so a DM chat
and a server chat can be open at once. Idempotent. Run `npm run db:migrate`,
then **`npm run deploy-commands`** (the `/mari` definition changed).

### Gateway worker (Railway — see docs/RAILWAY.md; or anything that runs Node)

1. Upload the repo (or connect it) and set the start command to `npm run worker`
   (`tsx worker/gateway.ts`; `tsx` is now a runtime dependency). Node 24 per
   `package.json` `engines`; if the host is older, check that it still runs.
2. Set the same env vars as the Vercel deployment — `DISCORD_BOT_TOKEN`,
   `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `DISCORD_PUBLIC_KEY`, `DATABASE_URL`
   (Neon *pooled* string), `LLM_*` — plus **`GATEWAY_WORKER=true`**. If the host
   wants an HTTP port, the worker listens on `$PORT` with a health response.
3. Keep the Discord Interactions Endpoint URL pointing at Vercel. Interactions
   never reach the worker, so nothing is handled twice.
4. Message Content is *not* a privileged intent here: Discord includes message
   content for DMs and for messages that mention the bot. **Verify on first
   run** (DM the bot, then `@Mari hi` in the server). If mentions arrive empty,
   enable the *Message Content Intent* in the Developer Portal.
5. If the worker is down nothing breaks: slash commands, buttons, reminders,
   `/mari` (public, or `private:true`), the Reply button and the cron poller keep
   working — only typed DMs / `@Mari` lose their instant path.
6. Security: the worker holds the bot token and `DATABASE_URL` on a third-party
   host. Prefer a dedicated Neon role; rotate the token if you ever leave.

**Not verified from this sandbox** (no route to Discord): discord.js delivering
DM `messageCreate` events with `Partials.Channel` on the target host; the
content-for-mentions behaviour above; that the host keeps a Node process alive
24/7 on its free tier; the typing indicator refresh. Everything else was run:
Postgres 16 locally, migrations applied, and `tests/integration/chatE2E.test.ts`
drives the exact functions the worker calls (`routeDmMessage` +
`deliverConversationReply`, `runServerChatTurn`).

**Behaviour you might trip over**

- A DM to the bot with no open chat *and* no worker running does nothing; use
  `/mari private:true` to open one.
- In a server chat the player's message is visible as the slash command / the
  mention itself; there is no Reply button there (nothing to echo).
- Forgetting deletes the memory and its evidence; the raw `ai_messages` rows
  stay (never fed back after a chat closes). Purging those too is a small
  follow-up if wanted.
- The public "forget" reply repeats what was dropped, which is fine because a
  server chat can only forget things that were already public.

**Tests:** 398 unit, 173 integration (all run against real Postgres, all
passing). New: `tests/unit/chatFeatures.test.ts` (parser, prompts, retrieval,
gating, deferral) and `tests/integration/chatE2E.test.ts` (21 tests: separation
both ways, silent save, dedupe, forget + ownership, 5 h rollover, cap, failure
handling, worker/poller idempotency). Five old tests that asserted the removed
Forget-button flow / DM-only `/mari` / `PRIVATE` default were rewritten to the
new behaviour rather than deleted. Mutation checks: making server-chat saves
`PRIVATE`, letting a public audience read `PRIVATE`, and dropping the SQL
ownership check each made tests fail.

## 2026-09-30 — Facts are used when the conversation leans toward them

**Problem.** Retrieval always filled its quota (10 memories per chat turn, 4 per
reaction, 6 teammate memories in the server chat) and the prompt block was
labelled "RELEVANT MEMORIES" whether or not they were. The model treats
whatever is in front of it as something to use, so Mari kept forcing facts
into replies that had nothing to do with them. The same happened with the
match blocks (who's playing, last result), which were attached to every chat.

**Can prompt wording alone fix it?** Only partly, and not reliably: the same
lesson was already learned with role/agent recitation (see `mariPersona.ts`,
"prompt wording alone did not stop that"). So the fix is mostly *not putting
irrelevant facts in the prompt*, plus rule text that makes "use none" the
default.

**What changed (plan sections 30, 32, 33, 57; design principle #11).**
- `memoryRetrieval.ts`: relevance gate. When retrieval gets the player's
  recent text, a memory must share a meaningful word with it
  (`MIN_QUERY_RELEVANCE`) or it is dropped before ranking, however high its
  importance/recency. Greetings and filler therefore retrieve nothing. Light
  stemming (exam/exams) and a list of words that appear in nearly every
  Valorant-team memory (game, play, valorant, team...) so they don't count as
  a match. Ceilings lowered: 3 per chat turn (was 10), 2 per reaction (was 4).
  Privacy filtering still runs first.
- "Context" = the player's last two messages (`recentPlayerText`), so a short
  follow-up ("and ali?") still leans on what it follows. CONSOLE reply turns
  are gated the same way; the CONSOLE *opening* has no player text, so it
  carries no memories.
- CELEBRATE/ROAST (button reactions) have no text to judge against, so the
  memory block is shown on about one reaction in three
  (`memorySpotlight`, same idea as `valorantSpotlight`).
- `teamFactsService.ts`: a teammate's shared memory rides along only when it
  connects to the recent messages or the teammate is named; ceiling 2 (was 6).
- `conversationContextBuilder.ts`: the next-match block only when the recent
  messages are about the match/schedule, the last-match block only when they
  are about how it went (`chatMentionsMatch` / `chatMentionsMatchHistory`).
  Roster names stay (Mari needs them to talk about a teammate) and the TEAM
  block is labelled reference-only.
- Prompt rules (single-shot, CONSOLE, DM/server chat): using no memory is the
  normal case; at most one; skip it if it needs a stretch; never repeat one
  already brought up in the conversation.

**Not built, on purpose:** embeddings. The relevance check is one function
(`keywordOverlap` behind `isRelevantTo`); if keyword matching turns out to
miss too many paraphrases in real use, that is the single seam to swap for
embedding similarity (plan section 32) without touching anything else.

**Tests.** New `tests/unit/relevanceGate.test.ts`; existing tests that
attached memories to unrelated messages were updated to send on-topic ones.
`AiService.memorySpotlightOneIn` is the test seam integration tests use to
make the reaction spotlight deterministic.

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

## Voice (gateway worker) — Groq Orpheus, 2026-10-01

Mari can join a voice channel, hear roster players say her name, and answer
aloud (`worker/voice.ts`; plan section 4 revision of 2026-10-01).

**Why Kokoro was dropped.** `kokoro-js` dragged in `onnxruntime-node` (208 MB),
`onnxruntime-web` (92 MB) and the Hugging Face libraries — a 422 MB install plus
an ~86 MB model download on first run. Small free hosts fail that install in a
different way each time, and a missing/corrupt `node_modules` switched ALL voice
off (the worker logs `voice.disabled` with the package that failed). Text-to-speech
is now Groq's hosted Orpheus, through the same `GROQ_API_KEY` as Whisper.

**Host install: ~14 MB, 12 packages** — `@discordjs/voice`, `@snazzah/davey`
(required by `@discordjs/voice` for Discord's DAVE encryption; ships a
per-platform native build, so it must be installed ON the host, never copied from
your PC), `opusscript`, `dotenv`. Upload only `dist/gateway.js` +
`dist/package.json` and let the host run `npm install`. Never upload `node_modules`.

**Orpheus facts (from Groq's docs)** — model `canopylabs/orpheus-v1-english`,
endpoint `/openai/v1/audio/speech`, WAV only, **max 200 characters per request**,
voices autumn / diana / hannah / austin / daniel / troy, `[direction]` tags for
delivery. So a reply is split at sentence boundaries into chunks of <=200 chars
(max 3 per reply, replies capped at 400 spoken chars), synthesized in parallel and
played as one clip. `[bracketed]` text in a reply is stripped before synthesis so
chat content can never act as a vocal direction.

**Check before relying on it:** Groq's free-plan TTS request/day limits (see
console.groq.com/docs/rate-limits) and whether your account must accept Canopy
Labs' model terms in the Groq console — a 400/403 from `voice.tts.failed` in the
logs shows the exact message. With `VOICE_DEBUG=1` she speaks a greeting on join,
which tells "can't speak" apart from "can't hear".

**Not verified from this sandbox:** a live call to Groq (no route to api.groq.com)
and a live Discord voice session. Verified: WAV parsing, chunking, config and PCM
resampling (`tests/unit/voiceTts.test.ts`, 18 tests), typecheck, the bundle starting
on the 14 MB install, and all voice packages loading from it.

### `/mari-join` — which channel, and when (2026-10-01)

`/mari-join channel:<voice channel> [time] [date]` (admin only). `time` omitted =
now; otherwise the same forms as `/create-match` (`19:00`, `7pm`, `evening`,
`2 hours`), in the team timezone; `date` needs a `time` and defaults to today.
A time earlier today is rejected instead of silently meaning "now".

- The command only stores a row in `voice_join_requests` (migration
  `0012_add_voice_join_requests.sql`); the **worker** polls every 15 s
  (`VoiceManager.runScheduledJoins`) and joins. So it needs the worker running with
  voice enabled, and the serverless app never touches voice.
- One pending request per guild: a new one replaces the old one (that is also how
  you fix a wrong time). There is no separate cancel command yet.
- At the join time she joins if someone is in the channel; if it is empty she waits
  up to 30 minutes, then the request is `EXPIRED`. She leaves when the channel empties.
- An explicit request moves her out of whatever channel she was in.
- Claiming a request is an atomic `PENDING -> CLAIMED` update (plan section 50), so
  overlapping ticks can't join twice. Outcomes are `DONE`, `FAILED` (channel missing,
  or no Connect/Speak permission: see `voice.join.*` in the worker log), `EXPIRED`,
  `CANCELLED`.
- `VOICE_CHANNEL_ID` is now optional: it only names a default channel she also
  auto-joins when a roster player walks in. Voice is enabled by `GROQ_API_KEY` alone.

**After deploying:** run `npm run db:migrate` and `npm run deploy-commands`, then
upload the rebuilt `dist/gateway.js`.

**Tests:** `tests/unit/mariJoin.test.ts` (command), `tests/unit/voiceScheduledJoins.test.ts`
(worker polling with fakes), `decideJoin` cases in `tests/unit/voiceTts.test.ts`,
`tests/integration/voiceJoinRepository.test.ts` (real Postgres: replace, atomic claim,
due-ness, finish). Not verified: a real join in Discord (no route from this sandbox).

### Voice troubleshooting: "she joins but doesn't speak" (2026-10-01)

Read the worker log with `VOICE_DEBUG=1`. In order:

1. `voice.tts.generated` present -> Groq works (text-to-speech is fine). `voice.tts.failed` -> Groq's status/body is logged.
2. `voice.player.state ... buffering -> playing` -> audio was handed to Discord.
3. `voice.conn.state ready -> signalling -> disconnected` within milliseconds means the voice
   WebSocket closed AND the main gateway wasn't ready at that instant (discord.js'
   `sendPayload` returns false -> `AdapterUnavailable`, `reason: 1`). Both Discord
   connections dying together is the signature of the whole process being frozen or
   starved by the host, not of a Groq or audio problem. Look for `voice.loop.lag`
   (the worker detected it was stalled) and `worker.shard.disconnect` around the same time.
4. `voice.conn.debug` lines (`[WS] ...`, `[NW] ...`, DAVE) only exist with `VOICE_DEBUG=1`:
   `joinVoiceChannel` needs `debug: true` for the library to emit them — it was missing before,
   which is why the close code was invisible.

What the worker now does about a dropped connection: waits for the main gateway, then
rejoins up to 4 times (`voice.conn.recovered` / `voice.conn.recoverFailed`) instead of leaving
after 5 s. A close code 4014 (moved/kicked) is still treated as "she was removed".
`voice.speak.interrupted` means the connection dropped mid-sentence (before: logged as done).
Audio is fed to the Opus encoder one 20 ms frame at a time, so playback never encodes a whole
clip in one synchronous burst. These make her tolerant of short stalls; they cannot make a
host that freezes for a minute at a time reliable.

**Env:** `VOICE_SPEED` no longer exists (Orpheus has no speed setting). An old
`VOICE_NAME=af_heart` falls back to `hannah`. New optional: `VOICE_TTS_MODEL`,
`VOICE_DIRECTION`. `VOICE_PITCH` now defaults to 1.

---

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
│   ├── commands/      # setup, createMatch, editMatch, cancelMatch, listMatches, postMatch, addPlayer, editPlayer, removePlayer, player, memories, completeMatch
│   ├── interactions/  # dispatchCommand, dispatchButton
│   ├── discordRest.ts, verifyInteraction.ts, httpInteractionAdapter.ts, handleDiscordInteraction.ts
│   ├── permissions.ts, commandGuards.ts, displayName.ts, announcementSync.ts, timezone.ts
│   ├── consoleConversation.ts   # Phase 7: DM opener, Reply modal, reply delivery
│   ├── memoryDelete.ts                       # Phase 8: 🗑️ delete button handler (list + auto-save Forget note)
├── modules/
│   ├── matches/     # matchService, matchLifecycle, dateTime; postMatchService, matchEvents (Phase 10)
│   ├── attendance/  # attendanceService, rosterMessage, customId
│   ├── reminders/   # reminderScheduling (pure planning), reminderMessages (nudge text)
│   ├── players/     # playerValidation (agent/topic parsing, role choices) — Phase 5
│   ├── ai/          # aiService, aiContextBuilder, aiOutput, aiMode (Phase 6); conversationService, conversationContextBuilder, conversationCustomId (Phase 7); teamAiContextBuilder (Phase 10)
│   └── memories/    # memoryService, memoryManageCustomId (Phase 8); memoryRetrieval (Phase 9)
├── database/{schema,repositories}/   # schema: serverConfig, matches, attendance, reminders, players, aiConversations, memories, memoryEvidence, matchEvents
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
npm test               # unit tests only — no infrastructure needed (345 tests)
npm run test:integration  # requires DATABASE_URL pointing at a disposable
                           # Postgres with migrations applied (137 tests; see the Phase 10
                           # notes for the 6 that fail on the original upload too)
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
- ✅ Protected-topic *filtering into an AI context*: Phase 8's candidate
  validation rejects a proposed memory whose own content touches a
  forbidden topic at write time (`tests/unit/aiOutput.test.ts`); Phase 9's
  `isEligible` re-applies the exact same check at *read* time, against
  whatever the player's protected topics are *now* — not just what they
  were when the memory was saved (`tests/unit/memoryRetrieval.test.ts`)
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
- ✅ Memory *retrieval* into an AI context (structured filtering + ranking
  + privacy filtering; semantic/embedding filtering deliberately not
  built — design principle #11, see the Phase 9 notes above)
  (`tests/unit/memoryRetrieval.test.ts`,
  `tests/integration/phase9RetrievalE2E.test.ts`)
- ✅ Memory table, evidence, visibility defaults, and auto-save (plan
  sections 21-25, 42-44, section 21 revised 2026-09-26): candidate
  validation and every section 22
  category (`tests/unit/aiOutput.test.ts`), evidence-cascade and
  per-player deletion scoping (`tests/integration/memoryRepository.test.ts`),
  and the full propose → auto-save → Forget-button delete → double-delete
  idempotency → cross-player rejection → `memoryUsageEnabled: false` →
  `/memories` → delete flow (`tests/integration/phase8MemoryE2E.test.ts`)

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
- [x] Phase 8 — Memory System (`memories`/`memory_evidence`, auto-save on a
      CONSOLE wrap-up with a one-tap Forget button — revised 2026-09-26 from
      the original consent-first Remember/Don't Remember design, see plan
      section 21's changelog note — plus `/memories` self-service view +
      delete) — passive channel-message scanning deliberately not built; see
      the Phase 8 notes above for why
- [x] Phase 9 — Retrieval (structured filtering + ranking + privacy
      filtering + context builder — semantic/embedding retrieval
      deliberately not built; a 6-7 person team's per-player memory count
      doesn't justify it yet, see the Phase 9 notes above for why)
- [x] Phase 10 — Match Hype / Recaps (`/complete-match`, `match_events`,
      `MATCH_EVENT` team memories, hype on the closest-to-kickoff reminder)

Each phase will be checked against `Full_Development_Plan.md` before
implementation, per the ground rule for this project.
