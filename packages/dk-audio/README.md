# @dkplus/dk-audio

`dk-audio` is a publishable ESM package and CLI for phase-one audio work:
transcription, canonical-transcript translation and summary, plus deterministic
music metadata and AI-routed music emotion analysis.

## Install and use

```bash
pnpm add @dkplus/dk-audio
dk-audio --help
dk-audio describe --json
dk-audio speech summarize transcript.json --json
dk-audio music metadata song.wav --json
dk-audio music analyze song.wav --jsonl
dk-audio speech translate transcript.json --to zh --json
```

All commands accept `--help`, `--version`, `--schema`, `--config <path>`,
`--json`, `--jsonl`, `--quiet`, `--verbose`, `--force`, and `--no-cache`.
Normal JSON output is one success-or-error envelope; errors return exit code 1.
Use `dk-audio speech summarize --schema --json` to inspect a command contract.

## Commands

| Command | Input | Output |
| --- | --- | --- |
| `speech transcribe` | audio file | canonical transcript |
| `speech translate --to <language>` | canonical transcript | canonical transcript |
| `speech summarize` | canonical transcript | typed summary |
| `music metadata` | audio file | deterministic metadata |
| `music emotion` | audio file | typed emotion |
| `music analyze` | audio file | exactly `{ metadata, emotion }` |

The machine-readable command list is [commands.json](./commands.json).

## Programmatic API and configuration

`transcribeAudio` requires an injected `AudioTranscriber` with feature ID
`audio.speech.transcribe`. The CLI deliberately returns
`AUDIO_TRANSCRIBER_UNAVAILABLE` until an application supplies such an adapter;
it never forwards raw audio bytes to a Qwen-compatible Chat endpoint.

`translateTranscript` similarly requires an injected `TranscriptTranslator`.
`summarizeTranscript` and `analyzeMusicEmotion` accept a typed `AIProvider` and
send feature-routed tasks using `audio.speech.summarize` and
`audio.music.emotion`, respectively. The domain package does not read API keys,
provider URLs, or environment credentials.

```ts
import { createMockProvider } from "@dkplus/ai-core";
import { summarizeTranscript } from "@dkplus/dk-audio";

const summary = await summarizeTranscript(transcript, {
  provider: createMockProvider(() => ({
    summary: "A short greeting.",
    topics: ["greeting"],
    keyPoints: ["hello"],
    participants: [],
    decisions: [],
    questions: []
  }))
});
```

`readAudioMetadata` obtains duration, codec, sample rate, channels, and bitrate
from local `ffprobe` data. Music tags that are unavailable locally (`bpm`,
`key`, `mode`, `loudness`) are always `null`; no values are invented.

## Validation and tests

Inputs to translate and summarize are parsed with the canonical `Transcript`
contract. Malformed input produces `INVALID_TRANSCRIPT`; missing adapters and
providers produce typed configuration errors. Tests cover help, version, schema,
JSON envelopes, malformed transcript errors, all six APIs, and the six-command
manifest.

```bash
pnpm --filter @dkplus/dk-audio build
pnpm --filter @dkplus/dk-audio test
pnpm --filter @dkplus/dk-audio typecheck
pnpm --filter @dkplus/dk-audio lint
```
