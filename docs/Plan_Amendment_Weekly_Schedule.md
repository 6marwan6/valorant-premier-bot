# Plan Amendment — Weekly Schedule Voting (2026-10-03)

`Full_Development_Plan.md` stays the source of truth. This file records, section by
section, what the owner asked to change and what was built, so the plan can be updated to match.
Everything not listed here is unchanged.

## Request (owner)

- Post a **weekly schedule** of matches, each with its time; players **vote on when they want to play**.
- A player can say they **can't play any day**.
- Reminders **5 hours** and **15 minutes** before the match.
- The reminder is for the **highest-voted time**, by default, **if it has 5+ votes** (5 are needed to play).
- The admin can add an **additional time edit** — e.g. 5 voted Saturday 7 pm, the reminder says "we're queuing at 7:30 pm".
- The message should look like **Valorant Premier** and be cool.

## What changes in the plan

| Plan section | Before | Now |
|---|---|---|
| §3 / §11 Match creation | Admin creates one match (`/create-match`), everyone confirms it | Admin posts a week of slots (`/create-schedule`); players vote. `/create-match` and the attendance flow are untouched and still work |
| §15 Attendance | `PLAYING` / `CANNOT_PLAY` / `WANTS_TO_BUT_CANNOT` per match | Per slot: "I can play this slot" (toggle, any number of slots) and one poll-level "can't play any day". Votes are rows in `schedule_votes` / `schedule_declines`, unique per (slot, player) |
| §13 / §53 Reminders | Default 3 h / 1 h / 15 min | Default **5 h / 15 min** (still `server_config.reminder_schedule_minutes`; servers on the old default are moved by migration 0016, customized schedules are left alone) |
| §13 Reminder target | Every match | The **leading slot**: most votes, at least 5 (ties → earliest). Decided at send time from live votes |
| §14 / §16 Public message | One match card, edited in place | One schedule card, edited in place: board of slots with vote bars, voters per slot, "can't play any day", "no vote yet" (from the roster) |
| §41 Admin commands | create/edit/cancel/list/complete match… | + `/create-schedule`, `/schedule-slot`, `/cancel-schedule` |

## Decisions made while building (please confirm or correct)

1. **Reminders count back from the queue time**, not the slot time, when the admin set one (queue 19:30 → reminders at 14:30 and 19:15).
2. **Only registered players can vote** once a roster exists (§15 step 2, "identify the player"), because votes decide whether we queue. Before any `/add-player`, anyone can.
3. **Votes toggle** (tap again to take it back). The unique index means a duplicated click can never create a second row (§15/§50).
4. **If a poll is made late**, only the closest due reminder is sent — never a stale "5 hours".
5. **`/schedule-slot reminders:always|never`** lets the admin override "leading slot only" (e.g. two matches in one week).
6. **One open schedule at a time**: `/create-schedule` refuses while another has upcoming slots.
7. **Facts stay deterministic**: nothing factual on these messages is written by the LLM (§14, principle #9). Mari's reactions to votes (below) are the personality layer only.
8. 5 players needed is the constant `MIN_PLAYERS_TO_QUEUE`.

## New commands

- `/create-schedule slots:"sat 7pm, sun 7pm"` — also `25/06 19:00, 26/06 19:00`; times in the team timezone; max 10 slots.
- `/schedule-slot slot:1 queue:19:30` — set the queue time (`queue:clear` to remove); `reminders:auto|always|never`.
- `/cancel-schedule` — removes the buttons, stops the reminders.

## Schema (migration `0016_add_weekly_schedules.sql`)

`schedule_polls`, `schedule_slots` (position, scheduled_at, queue_at, remind_mode, quorum_announced_at),
`schedule_votes`, `schedule_declines`, `slot_reminders` (same claim → send → mark pattern as `reminders`).

## Tests

Unit: scheduleLogic, scheduleCustomId, scheduleMessage. Integration (real Postgres): `scheduleE2E` — creation and duplicate guard,
toggle/decline semantics, roster gate, past-slot rejection, button flow, squad-locked posted once, Discord failure isolation,
5 h / 15 min reminders once each, no reminder below 5 votes, queue-time edit, late poll, always/never/cancel, retry after failure.

---

# Part 2 — AI reactions to schedule votes, and server members (2026-10-03)

## Request (owner)

- Wire the AI into the schedule votes.
- A separate **server member** type: people in the server who are not Premier players but still talk to the AI, the RAG (memory/retrieval) and other features — and **don't take part in anything Premier-related**.

## AI reactions (plan §17–20, §35–37)

| Action | Mode | Notes |
|---|---|---|
| First slot a player votes for in a poll | CELEBRATE | public @mention card in the schedule channel |
| "Can't play any day" | ROAST | respects the player's roast intensity, banter style, protected topics |

- **At most once per player per poll, per kind.** Claimed in the database (`schedule_ai_reactions`, unique on poll+player+kind) *before* the model is called, so toggling votes, tapping a second slot or a duplicate click never spams the channel (§50).
- The prompt only says which slot was voted for, or that they can't play any day — never counts or other voters (§14). The same output validation as attendance reactions applies, including protected topics (§10, §35).
- If the AI is off, fails, is rejected by validation, or Discord refuses the post, the vote is unaffected and nothing public is posted (§48, principle #8).
- CONSOLE (§20) isn't triggered: the weekly schedule has no "want to, but can't" answer.

## Server members (a plan extension — §8, §54)

A member is a profile row with `kind = MEMBER` (no role/agents). Because it is the same row, everything keyed on a person works unchanged: server chat (`/mari`, `@Mari`), DM chat, voice, memories + retrieval, `/memories`, AI settings, protected topics.

| | Premier player | Server member |
|---|---|---|
| Chat with Mari, memories/RAG, DM, voice | yes | yes |
| AI settings, protected topics (§9, §10) | yes | yes — same filtering |
| On the Premier roster / "No vote yet" / denominators | yes | **no** |
| Vote on the weekly schedule | yes | **no** (told so, nothing recorded) |
| Match attendance buttons | yes | **no** |
| Reminders, hype, recaps, match events | yes | **no** |
| Role + agents | required | none |

Commands: `/add-member` (admin; roast intensity, banter style, protected topics), `/add-player` also **promotes** a member (keeps their memories, AI settings and protected topics — no silent privacy reset), `/edit-player` works for members' AI settings but refuses role/agents, `/remove-player` works for both, `/player` labels members.

Privacy (§44): a public reply must respect **everyone's** protected topics, so the union used for public chat covers members as well as players, and members' shared (TEAM) memories can come up in chat like a player's. Private memories stay private either way.

Schema: migration `0017_add_server_members_and_schedule_ai.sql` — `players.kind` (default `PLAYER`, so all existing rows are unchanged), `players.role` nullable, `schedule_ai_reactions`.

## Decisions to confirm

1. A member **cannot be demoted by accident**: `/add-member` refuses an active Premier player (use `/remove-player` first).
2. Members don't appear in the plan's team roster facts (who's playing, agents), but Mari still knows them from chats and memories.
3. Anyone with no profile at all still gets "ask an admin to add you" from Mari, as before — now pointing at `/add-member` or `/add-player`.

---

# Part 3 — Roster @mentions and the Agent Pick panel (2026-10-04)

## Request (owner)

1. Roster players are @mentioned on the schedule message, so they're notified when it's sent.
2. The message that appears when someone chooses a date becomes an **agent pick** message: the map, 1–2 suggested comps, other options per role, agents grouped by role, an option to add an agent that isn't listed (showing who suggested it), each agent with its in-game picture, and whether someone already picked it.

## @mentions

- The schedule card's text carries an @mention of every active Premier player, and the first post (`/create-schedule`) is sent allowing exactly those mentions — that is the notification. Server members are not on the roster, so they aren't pinged.
- Voter lists, "can't play any day" and "no vote yet" now show real mentions instead of typed names. An embed never notifies by itself.
- Every later re-render (votes, picks, `/schedule-slot`, `/cancel-schedule`) is sent with mentions suppressed, so nobody is pinged twice.

## Agent pick panel (plan §14: all facts from the database, nothing written by the model)

Choosing a date now opens a **private** panel (replacing the plain "you're in" text; Mari's public reaction card is unchanged):

- **Header:** day/time, **map** (or "TBD"), **Suggested Comp A / B** for that map (an agent already picked is ticked), your pick, and the squad's picks so far.
- **Role tabs:** Duelists · Initiators · Controllers · Sentinels. The open tab shows each agent as a card with its **in-game portrait**; suggested agents first, then the other options. Each card says **OPEN**, **YOUR PICK**, or **PICKED BY @someone**; agents held by someone else have their button disabled.
- **Buttons:** pick an agent, **Clear my pick**, **➕ Add an agent**, **Switch slot** (only if you voted for more than one).
- **Add an agent:** a popup asks for the name; it is added to the open role tab, the card says **ADDED BY @you**, and everyone sees it from then on. A built-in agent can't be added twice (any spelling, e.g. `kay-o`), an earlier suggestion says who added it, names are 2–20 letters/numbers/`. ' / -`, at most 5 per player and 15 per role. Suggested agents show a role badge since they have no portrait.
- **Rules:** a player holds one agent per slot, and an agent has one holder per slot (Valorant has no duplicate agents on a team); two players tapping the same agent at once is settled by a database unique index. Taking back your vote, or "can't play any day", frees your agent.
- **Where picks show:** the schedule card lists each voter as `⚔️ @name · **Jett**`; the squad-locked card and the 5 h / 15 min reminders show each player's pick (falling back to their profile's preferred agent) and the map.
- **🎯 PICK AGENT** on the schedule card reopens the panel later (for your first upcoming slot; use *Switch slot* for another).
- Only Premier players who voted for the slot can use the panel; server members are told it's for Premier players.

## Map

`/schedule-slot slot:1 map:Ascent` (all 13 maps, or "not decided yet") — shown on the card board, the slot heading, the panel, the squad-locked card and the reminders. It is a manual setting because a Premier map isn't known when the week is posted.

## Data (all in `src/modules/agents/agentData.ts`, editable)

- **Agents:** 29 playable agents with role and portrait id, checked 2026-10-04 against valorant-api.com (includes Veto and Miks). Portraits load from `media.valorant-api.com`; if that CDN were down the cards simply show without pictures.
- **Comps:** **my starting suggestions, not meta gospel.** Two per map for 11 maps; **Corrode and Summit have none yet and use the general comps** (labelled "general"). The map pool changes every Act (the next change is around 14 Oct), which is why the map list is all 13 and not just the current pool.

## Schema (migration `0018_add_agent_picks_and_slot_map.sql`)

`schedule_slots.map`, `agent_picks` (unique per slot+player and slot+agent), `custom_agents` (per server).

## Decisions to confirm

1. Comps and the Corrode/Summit fallback (above) — tell me the comps you actually want per map and I'll replace them.
2. Picks are per match slot, so the same player can play different agents on different days.
3. No admin command yet to remove a bad suggested agent (each shows who added it); easy to add.
4. The panel is a snapshot: it redraws on every tap, but doesn't live-update when someone else picks.
5. Mentions inside embeds can show as "@unknown-user" for someone Discord hasn't loaded on a client; the ping line in the message text is unaffected.

---

# Part 4 — Roomier messages, horizontal agent pick, public lineup (2026-10-07)

## Request (owner)

1. The schedule and agent-pick messages are too crowded — especially the agent pick — and need more space.
2. A **main agent-pick message visible to everyone** that shows which agents have been picked so far and who picked them.
3. In the (private) agent pick, show the agents **horizontally, not vertically**, to look more like Valorant.

Plan sections touched: §14 (facts stay deterministic — still true: nothing here is written by the model), §16 (one public message edited in place, as for the match roster), §44 (the lineup only repeats what the schedule card already shows publicly: who voted for a slot and which agent they took), principle #8 (a failed Discord call never affects a vote or pick).

## What changed

| | Before | Now |
|---|---|---|
| Schedule card | One packed embed: board, then a field per slot repeating the same slots | Two embeds: **status + board**, then **WHO'S IN** — one block per slot, a blank line between blocks, then "can't play any day" and "no vote yet". Buttons unchanged |
| Agent pick panel | Header + one tall embed per agent (up to 10 embeds) | Two embeds: a header (when, map, your pick, comps A/B, squad) and **one grid of agents, three across**, each cell = portrait + name over OPEN / YOU / 🔒 @player. Your picked agent's portrait is the header thumbnail |
| Public pick message | none | **AGENT SELECT lineup**: one message per schedule, edited in place. Per slot with votes: map, "N/M locked in", the picks side by side (agent over player, ordered Duelists → Initiators → Controllers → Sentinels), and who is still choosing. Has a 🎯 PICK AGENT button |

## Why "horizontal" looks like this (Discord's limits)

Embeds always stack vertically; the only things that sit side by side are *inline fields* (3 per row), buttons (5 per row) and inline emoji. So the agents are a 3-across grid of inline fields, and the portraits are **application emojis** that sit inline in a cell's name and on the buttons. A card-per-agent with a big picture each cannot be made horizontal in Discord.

Portraits as emoji need one setup step: **`npm install` (once, for the `sharp` dev dependency) then `npm run sync-agent-emojis`**. For each agent the script asks valorant-api.com for the agent's image URLs (falling back to the same `displayicon.png` the panel thumbnail uses), resizes the image to a 128×128 PNG, and uploads it as the application emoji `agent_<key>`. It is safe to re-run (agents that already have one are skipped, e.g. after adding a new agent to `agentData.ts`), and it repeats every failure reason at the end. The first version guessed a `displayiconsmall.png` URL that 404'd for all 29 agents (2026-10-08); URLs are now read from the metadata instead.

Where the portrait shows once uploaded: each cell and button of the agent pick grid, the comps and squad list in the panel header, each pick on the public AGENT SELECT lineup, and each pick on the schedule card's "WHO'S IN" block. **Until the sync is run (or if Discord can't be reached) all of those use the role glyph / plain text instead** — nothing breaks. The app picks new emojis up within 10 minutes. Agents added with "➕ Add an agent" have no portrait. A portrait is an inline emoji, so it is about text height; Discord cannot show a different large picture per cell (a large strip would need a generated image — not built).

## Lineup message — behaviour

- Posted by `/create-schedule` right under the card; a schedule created **before** this change gets one on its next vote or pick.
- Refreshed after every vote, "can't play any day", agent pick/clear, `/schedule-slot` and `/cancel-schedule` (cancelled: the text says so and the button is removed).
- Never pings anyone (mentions inside embeds don't notify, and it is sent with mentions suppressed). Slots that have started are left out.
- Posting is claimed in the database first, so two simultaneous clicks post one message (§50); a crashed poster's claim expires after 60 s. If someone deletes the message, the next change posts a fresh one.
- A Discord failure is logged and swallowed — the vote or pick is already saved (§48, principle #8).
- Discord's 6000-character limit across a message's embeds is enforced: with an unusually large number of voters (only possible before a roster exists) fewer players are listed per slot, with "+N more".

## Schema (migration `0019_add_agent_board_message.sql`)

`schedule_polls.agent_board_message_id` and `agent_board_claimed_at`. Run the migration, then (optionally) `npm run sync-agent-emojis`. No new slash commands, so `deploy-commands` is not needed for this change.

## Decisions to confirm

1. The lineup is **one message for the whole schedule** (a card per slot with votes), not one per slot.
2. The squad list stays on the private panel as a short list, and is the full picture on the public lineup.
3. The comps are now text blocks in the header rather than fields (same content).
4. Not verified against live Discord: layout was checked as message data and tests, not by looking at it in a server — worth a glance after deploying, especially on mobile where inline fields may wrap to two across.

---

# Part 5 — "LOCKED IN" waits for the agent; reaction channel; map comps (2026-10-08)

## Request (owner)

1. Mari's public "LOCKED IN" card (the one with the AI text) should wait until the player has **chosen an agent**, so it shows the final pick.
2. The owner should **control which channel** it appears in.
3. How are the **comp suggestions per map** controlled?

Plan sections touched: §14 / principle #9 (the agent, slot and role on the card, and the agent line given to the model, are database facts; the model writes only the voice), §50 (the card is still claimed once per player per poll, before the model is called), §48 / principle #8 (a failed AI or Discord call never affects a vote or pick), §53 (configuration lives in the database: the channel is a `server_config` column).

## What changed

- **When:** a vote no longer triggers the card. The player's **first agent pick in that poll** does. The AI is told the slot and the locked-in agent ("Agent they locked in for that slot: Jett (Duelist)"). Later pick changes, other slots, and toggling votes stay silent (the claim is per player per poll, as before).
- **What it shows:** *Slot*, *Agent* (the **picked** agent, with its portrait emoji once uploaded) and *Role* (that agent's role). Before, the Agent field was the player's profile "preferred agent". The card's picture is the picked agent's portrait (the player's avatar stays in the author line); a player-suggested agent has no portrait, so the avatar remains the picture.
- **A player who votes but never picks** gets no card; the AGENT SELECT lineup shows them as "still choosing". (Say if you'd rather have a fallback card after some delay — that needs a timed job.)
- **"OUT THIS WEEK"** (the "can't play any day" roast) is unchanged: still immediate.
- **Channel:** `/setup reaction_channel:#channel` sets where both Mari schedule reactions are posted (the LOCKED IN and OUT THIS WEEK cards). `/setup reaction_channel_reset:True` goes back to the default, the schedule's own channel. Setting both in one call changes nothing. `/setup` now shows the current value. The schedule card, the AGENT SELECT lineup and the SQUAD LOCKED card are **not** affected: they stay in the match channel.

Because `/setup` gained two options, **re-run `npm run deploy-commands`** (and apply migration `0020_add_reaction_channel.sql`).

## Map comp suggestions — how they are controlled

They are plain data in `src/modules/agents/agentData.ts`, in `MAP_COMPS` (a map name → two comps). To change one, edit it and redeploy; there is no Discord command for it yet.

```ts
Ascent: [
  { name: "Standard",  agents: ["jett", "sova", "omen", "killjoy", "kayo"] },
  { name: "Fast hits", agents: ["neon", "fade", "astra", "cypher", "skye"] },
],
```

Rules (enforced by `tests/unit/agentData.test.ts`, which fails the build otherwise):

- The map name must be one of the 13 in `MAPS`; each map that has its own comps has **exactly two**.
- Each comp is **exactly five distinct agents**, written as their lowercase key (the name with only letters/digits: `kayo`, `jett`).
- Each comp must include **at least one of every role** (Duelist, Initiator, Controller, Sentinel), plus a flex.
- `name` is the label shown ("COMP A — Standard").
- A map with no entry (today Corrode and Summit) shows `GENERAL_COMPS` and says "(general)". To add one, add an entry for it. To change what everyone falls back to, edit `GENERAL_COMPS`.

An in-Discord command (e.g. `/map-comps`) is not built; it would store comps in the database instead of the file.
