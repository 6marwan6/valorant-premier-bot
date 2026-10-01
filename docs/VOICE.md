# Mari's voice: controls and speed

## Controlling her voice from `/mari-join`

`/mari-join` (admin only) takes three optional options next to `channel` and `time` (there is no `date` any more: a clock time that already passed today means tomorrow):

| Option | Values | Notes |
|---|---|---|
| `voice` | autumn, diana, hannah, austin, daniel, troy | picker in Discord |
| `direction` | one delivery word, e.g. `cheerful`, `whisper`, `sad` | letters only; type `none` to clear |
| `pitch` | 0.8 to 1.25 | 1 = unchanged; also shifts speed a little |

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
| `endWaitMs` | quiet time she actually waited after the last audio before sending the utterance: the full `VOICE_SILENCE_MS` (700), or the shorter `VOICE_VAD_END_MS` (450) when the VAD says the tail was not speech |
| `vad`, `speechMs` | whether the local VAD ran, and how many ms of real speech it found (0 = noise, dropped before STT) |
| `sttMs` | Groq Whisper transcription |
| `brainMs` | transcript in, reply text out: the language model plus database work |
| `firstAudioMs` | reply text in, first sound playing: TTS of the first chunk plus joining the player |
| `perceivedMs` | what the player actually waits: endWait + stt + brain + first audio |

Changes made for speed:

- Playback starts when the **first** chunk is ready; later chunks follow in order. The first chunk is one sentence.
- **Local VAD (Silero, `worker/vad.ts`).** Ends a turn after `VOICE_VAD_END_MS` instead of `VOICE_SILENCE_MS` when
  the last audio was not speech, and drops utterances with no speech in them before they cost an STT call.
  Honest limits: Discord clients stop sending audio when you stop talking, so the audio rarely contains the
  trailing silence, and a VAD can't tell a pause between two sentences from the end of a turn. Expect a gain on
  turns that end in breath/noise and a clear gain in *not answering noise*; read `endWaitMs` in the timing line
  to see what you actually get. It costs about 140 MB of disk and 100 MB of RAM; `VOICE_VAD=0` turns it off, and
  if it can't load she just uses the fixed window.
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

- Two or more humans in the channel: only when she hears her name. Exactly one human with her: she answers
  whatever they say (junk transcripts like "you" / "thank you" are dropped). Only roster players are listened to.
- She joins by herself only for `VOICE_CHANNEL_ID`. **If that variable is empty she joins only through
  `/mari-join`.** The worker re-checks every ~15 s, so a player already in the channel counts.
- She posts a text hello when she joins (voice channel chat, else the match channel). If neither is writable the
  log says `voice.announce.failed` with the reason (usually Send Messages missing in the voice channel's chat).

## Her voice

Defaults: Orpheus voice `hannah`, direction `flirty`, pitch 1.08. These are guesses made without being able to
listen: try `autumn` or `diana`, other direction words (`playful`, `teasing`, `cheerful`), and pitch 1.05 to 1.15
live with `/mari-join channel:<her channel> voice:... direction:... pitch:...`, then put the winner in `.env`.
What she says is unchanged (her persona and each player's spice level); only the delivery is new.

The Groq free-plan self-limits in `worker/voice.ts` (`STT_MAX_PER_MINUTE`, `MAX_TTS_CHUNKS`,
`MAX_SPOKEN_CHARS`) are unchanged; raise them if you are on a paid Groq tier.
