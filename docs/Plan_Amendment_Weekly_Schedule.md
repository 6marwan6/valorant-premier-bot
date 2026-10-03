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
