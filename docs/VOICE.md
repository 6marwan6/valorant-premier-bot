# Mari's voice: controls and speed

## Controlling her voice from `/mari-join`

`/mari-join` (admin only) now takes three optional options next to `channel`, `time` and `date`:

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
| `silenceMs` | quiet time she waits for before sending the utterance (`VOICE_SILENCE_MS`, now 700, was 900) |
| `sttMs` | Groq Whisper transcription |
| `brainMs` | transcript in, reply text out: the language model plus database work |
| `firstAudioMs` | reply text in, first sound playing: TTS of the first chunk plus joining the player |
| `perceivedMs` | what the player actually waits: silence + stt + brain + first audio |

Changes made for speed, none of which need a new library:

- Playback starts when the **first** chunk is ready; later chunks follow in order. Before, she waited for
  every chunk to be synthesized and resampled first.
- The first chunk is one sentence, so the first TTS request is as short as possible.
- The silence window is 200 ms shorter, tunable with `VOICE_SILENCE_MS`.

## Libraries: what would and would not help

Measure first: run a few turns and read `voice.turn.timing`.

- `brainMs` dominates: a faster model for voice, shorter spoken replies, or streaming the model's
  output sentence by sentence into TTS (touches `llmClient` and the structured reply path).
- `firstAudioMs` dominates: a TTS service that streams audio. That is a service, not a library, and
  the 2026-10-01 plan revision names Groq Orpheus, so switching needs a plan revision first.
- `sttMs` is already one hosted request; a local Whisper on CPU would be slower, not faster.
- Native Opus (`@discordjs/opus` instead of `opusscript`) only saves CPU on 20 ms frames. Not the
  bottleneck here.
- A VAD library (e.g. Silero through `onnxruntime-node`) could end utterances smarter than a fixed
  silence window. It is the one heavy local addition with a plausible gain, and the next step after
  the numbers above if the 0.7 s wait still feels long.
- FFmpeg is not needed: no transcoding happens.

The Groq free-plan self-limits in `worker/voice.ts` (`STT_MAX_PER_MINUTE`, `MAX_TTS_CHUNKS`,
`MAX_SPOKEN_CHARS`) are unchanged; raise them if you are on a paid Groq tier.
