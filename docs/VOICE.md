# Mari's voice: controls and speed

## Controlling her voice from `/mari-join`

`/mari-join` (admin only) takes four optional options next to `channel` and `time` (there is no `date` any more: a clock time that already passed today means tomorrow):

| Option | Values | Notes |
|---|---|---|
| `voice` | autumn, diana, hannah, austin, daniel, troy | picker in Discord |
| `direction` | one delivery word, e.g. `cheerful`, `whisper`, `sad` | letters only; type `none` to clear |
| `pitch` | 0.8 to 1.25 | 1 = unchanged; also shifts speed a little |
| `listen` | group / just one person / auto | whether she needs to hear "Mari" (see below) |

- Anything you leave out keeps the `VOICE_*` env default, or, if she is already in that
  channel, whatever she is using right now.
- If she is **already in the channel you name**, the new voice applies immediately and she does
  not reconnect: `/mari-join channel:#general voice:troy`.
- The choices apply to **this session**. When she joins fresh later (auto-join through
  `VOICE_CHANNEL_ID`, or a request for a different channel) she is back on the env defaults.
- The choices travel on the `voice_join_requests` row (migration `0013_add_voice_settings`), so the
  serverless app and the worker still only talk through the database.

### Deploy order (matters)

1. `npm run db:migrate` (the worker now selects the new columns; deploying it first would break
   the join poller).
2. Deploy Vercel, then `npm run deploy-commands` (the command definition changed).
3. Redeploy the Railway worker.

## Where the delay goes

Each answered turn now logs one `voice.turn.timing` line (no message content):

| Field | Meaning |
|---|---|
| `turn` | 1 for the first answer of a session: compare it with turn 2 and 3 to see a cold start |
| `silenceMs` | quiet time she waits for before sending the utterance (`VOICE_SILENCE_MS`, 700) |
| `sttMs` | Groq Whisper transcription |
| `brainMs` | transcript in, reply text out: the language model plus database work |
| `firstAudioMs` | reply text in, first sound playing: TTS of the first chunk plus joining the player |
| `perceivedMs` | what the player actually waits: silence + stt + brain + first audio |

Changes made for speed:

- Playback starts when the **first** chunk is ready; later chunks follow in order. The first chunk is one sentence.
- **Spoken replies are short.** Her prompt is told the reply will be spoken: one or two short sentences, plain
  words. That is the biggest `brainMs` lever, because output tokens are the latency.
- **Optional faster model for voice only:** `VOICE_LLM_MODEL` (same provider as `LLM_MODEL`), and
  `VOICE_LLM_MAX_TOKENS` if you want a hard cap (leave it unset unless replies get cut off: the reply is JSON, and
  a cap that is too small breaks it).

## Not built (needs a plan decision)

- **Streaming the model's reply into TTS sentence by sentence** would hide most of `brainMs`, but the plan
  (sections 10, 35, 55) requires the whole reply to pass validation (protected topics, mention neutralization,
  memory handling) before it is used, and the reply is a JSON object. Speaking the first sentence before the rest
  is validated would break that rule. If you want it, the plan needs a revision (for example: validate each
  sentence as it arrives, drop memory/forget side effects for spoken turns).
- **Streaming TTS** is a service feature, not a library; the plan names Groq Orpheus, which returns a whole WAV
  per request.

## When she answers, and joining

`/mari-join listen:` sets it for the session (`VOICE_LISTEN` is the default):

- **Group:** she answers only when she hears her name. Use it when several of you are in the channel.
- **Just one person:** she answers whatever the roster player says, no name needed. Use it when it's you and her.
- **Auto (default):** just-one-person while exactly one human is in the channel, group otherwise.

In every mode only roster players are listened to, and junk transcripts ("you", "thank you") are dropped when she
wasn't addressed. She posts **no** text message when she joins.

She joins by herself only for `VOICE_CHANNEL_ID`. **If that variable is empty she joins only through
`/mari-join`.** The worker re-checks every ~15 s, so a player already in the channel counts.

## The cold start

Two things made her first answer slow, and both are fixed (you can't see either from the player's side):

1. A speaking player was looked up in the database **before** her recording started, every time. After the
   database had been idle (Neon scales to zero) that wait ate the first words. Players are now cached for a minute.
2. The first request of everything (database, Groq connection, first Orpheus request) all landed on the first
   answer. On joining she now warms up in the background: one `voice.warmup` log line shows the time each step took
   (`dbMs`, `groqMs`, `ttsMs`). It costs one tiny TTS request per join; `VOICE_WARMUP=0` disables it.

Still possible, and not something code here can see: the LLM provider's own cold start. If `turn: 1` still has a
much bigger `brainMs` than turn 2, that's the model, and a different `VOICE_LLM_MODEL` or provider setting is the lever.

## `VOICE_LLM_MODEL`

Your `LLM_MODEL` already answers everything, voice included. `VOICE_LLM_MODEL` is an *optional override for voice
turns only*, so voice can use a smaller, faster model while typed chat, roasts and recaps keep the main one. Empty
(the default) means voice uses `LLM_MODEL`. It goes to the same provider and key.

## Her voice

Defaults: Orpheus voice `hannah`, direction `flirty`, pitch 1.08. These are guesses made without being able to
listen: try `autumn` or `diana`, other direction words (`playful`, `teasing`, `cheerful`), and pitch 1.05 to 1.15
live with `/mari-join channel:<her channel> voice:... direction:... pitch:...`, then put the winner in `.env`.
What she says is unchanged (her persona and each player's spice level); only the delivery is new.

The Groq free-plan self-limits in `worker/voice.ts` (`STT_MAX_PER_MINUTE`, `MAX_TTS_CHUNKS`,
`MAX_SPOKEN_CHARS`) are unchanged; raise them if you are on a paid Groq tier.
