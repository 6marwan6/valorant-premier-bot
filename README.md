# 🎯 M.A.R.I. — the sixth (and seventh) member of your Valorant Premier team

![Node](https://img.shields.io/badge/node-24.x-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-4169E1?logo=postgresql&logoColor=white)
![Hosting](https://img.shields.io/badge/runs%20on-Vercel%20(no%20VPS)-000000?logo=vercel&logoColor=white)

**M.A.R.I.** (*Marwan's Assistant for Reminders & Intelligence*) is a private Discord bot for a small Valorant Premier team. It reminds everyone about matches, collects who's playing, and then talks to each player like a teammate who actually knows them: it hypes the ones who show up, roasts the ones who don't, and comforts the ones who wanted to but couldn't.

## 🌟 Highlights

-  **Premier scheduling that just works.** Register a match once; M.A.R.I. posts it, sends reminders at the times you choose, and never sends the same one twice.
-  **One-tap attendance.** *I'm Playing*, *Can't Play*, or *Want to Play, But Can't* buttons on a single live roster message. No response is tracked too.
-  **A different relationship with every player.** Per-player roast intensity (0–100), favorite agents, and off-limits topics. One player gets destroyed, another gets gentle teasing, another gets encouragement.
-  **Talk to it directly** with `/mari`.
-  **Memory you control.** It remembers running jokes, agents, and match moments, and you can see or delete everything it knows about you with `/memories`. Admins can also seed players with starter facts by hand.
-  **Privacy is enforced in code, not in the prompt.** Protected topics and private memories are filtered out *before* the AI ever sees them.
-  **Post-match recaps and pre-match hype** built from your real roster, agents, and match notes.
-  **Cheap to run.** Serverless on Vercel + a managed Postgres. Built for one team, not thousands.

## ℹ️ Overview

Most Discord reminder bots are generic. M.A.R.I. is built for **one team of about 6–7 players** and tries to feel like part of it.

The design rule that makes this safe: **the database is the source of truth; the AI only writes the personality.** Facts like the match time, the roster, attendance counts, and who plays which agent all come from the database and are printed by the app. The language model is only asked to say something fun about them. It cannot change attendance, edit matches, or create permanent memories on its own. Anything it suggests goes through validation first.

Premier doesn't tell you who you'll face ahead of time, so matches are just a **date and a time**. There's no opponent field to fill in.

Everything M.A.R.I. does is derived from a single planning document, [`Full_Development_Plan.md`](docs/Full_Development_Plan.md), which is the source of truth for scope and behavior.

## 🚀 Usage

Once it's set up, an admin registers a match and the team takes it from there:

```text
/create-match  →  M.A.R.I. posts the roster message with three buttons
                  (and reminds the team 3h / 1h / 15min before, configurable)
```

Everyone taps a button, and the roster message updates live. Then each player gets a reply that depends on their answer *(illustrative examples)*:

| They tap | Mode | What M.A.R.I. sounds like |
| --- | --- | --- |
| 🟢 I'm Playing | `CELEBRATE` | *"LET'S GOOOO. Jett is reporting for duty. Try not to donate the first five rounds this time 💀"* |
| 🔴 Can't Play | `ROAST` | *"So you're abandoning us tonight? Interesting. I'll add this to the official evidence against you. 😭"* |
| 🟡 Want to, but can't | `CONSOLE` | *"NOOO 😭 You actually wanted to play? What happened?"*, then a real, private conversation |

After the match, `/complete-match` records the result and your notes ("Ahmed clutched round 19, Omar top-fragged") and posts a recap. Those moments can become memories that M.A.R.I. calls back to later.

### Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/setup` | Admin | Configure the server: timezone, match channel, admin role, default roast level |
| `/create-match` `/edit-match` `/cancel-match` `/list-matches` | Admin | Manage Premier matches |
| `/post-match` | Admin | Post (or repost) a match's roster message |
| `/complete-match` | Admin | Mark a match WIN/LOSS, add notes, post the recap |
| `/add-player` `/edit-player` `/remove-player` `/player` | Admin | Manage the roster: role, agents, roast intensity, protected topics |
| `/mari` | Player | Talk to the AI directly |
| `/memories` | Player | See what M.A.R.I. remembers about you, and delete anything |

## ⬇️ Installation

**You'll need:** Node.js 24, a PostgreSQL database ([Neon](https://neon.tech) works well), a [Vercel](https://vercel.com) account, a Discord application with a bot user, and an API key for an OpenAI-compatible LLM provider. The AI is optional: without a key, attendance and reminders still work and the bot falls back to plain messages.

```bash
git clone <your-fork-or-repo-url> && cd <repo>
npm install
cp .env.example .env        # fill in the values described below
npm run db:migrate          # create the tables
npm run deploy-commands     # register the slash commands with your server
```

| Variable | What it is |
| --- | --- |
| `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `DISCORD_PUBLIC_KEY` | From the Discord Developer Portal and your server |
| `DATABASE_URL` | PostgreSQL connection string (use Neon's *pooled* string) |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Your OpenAI-compatible provider (optional) |
| `CRON_SECRET` | Any long random string; protects the reminder endpoint |

Then:

1. Deploy to Vercel (connect the repo or use the CLI).
2. In the Discord Developer Portal, set the **Interactions Endpoint URL** to `https://<your-deployment>/api/interactions`.
3. Create a job on [cron-job.org](https://cron-job.org) (or similar) that calls `https://<your-deployment>/api/cron/reminders` every 5–15 minutes with the header `Authorization: Bearer <CRON_SECRET>`.
4. In Discord, run `/setup` with your match channel, then `/add-player` for each teammate.

## 🗺️ Status

All ten phases of the plan are built: Discord foundation, matches, attendance, reminders, player profiles, the three AI modes, private AI conversations, memory, retrieval, and hype/recaps. Semantic (embedding) search is deliberately not built yet: for a team this small, structured retrieval is enough.

Explicitly **out of scope**: a web dashboard, automatic match discovery from Riot, multi-server support, and voice.

## 💭 Feedback

M.A.R.I. is built for one specific team, but ideas and bug reports are welcome. Open an [issue](../../issues) and say what you saw.

## 🛠️ Development

```bash
npm test                    # unit tests, no infrastructure needed
npm run test:integration    # needs DATABASE_URL pointing at a disposable Postgres
npm run typecheck
npm run validate-commands   # offline check of the slash command definitions
```

Stack: TypeScript on Node 24, [discord.js](https://discord.js.org) (HTTP interactions, not a gateway connection), [Drizzle ORM](https://orm.drizzle.team) on PostgreSQL, Vercel functions, and an external cron scheduler.

Per-phase design notes and the decisions made where the plan left things open live in [`docs/BUILD_NOTES.md`](docs/BUILD_NOTES.md).

## 📜 Legal

[Privacy Policy](docs/Privacy%20Policy.md) · [Terms of Service](docs/Terms%20of%20Service.md)

## ✍️ Author

Built by **[Marwan](https://github.com/6marwan6)** for his Premier squad. GG. 🎮
