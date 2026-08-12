# @dkplus/dk-video

`dk-video` is the phase-one video CLI. It provides exactly eight commands for deterministic video artifacts, explicit subtitle transcription, transcript-grounded content analysis, and explicit artifact composition.

```bash
dk-video probe clip.mp4 --json
dk-video audio clip.mp4 --output clip.wav --json
dk-video filmstrip clip.mp4 --output clip.png --timestamps 0,10,20,30 --json
dk-video subtitles clip.mp4 --json
dk-video content summary clip.mp4 --transcript transcript.json --filmstrip filmstrip.json --config video-ai.json --json
dk-video analyze clip.mp4 --probe probe.json --audio audio.json --filmstrip filmstrip.json --subtitles transcript.json --summary summary.json --keywords keywords.json --highlights highlights.json --json
```

All commands support `--help`, `--version`, `--schema`, `--config <path>`, `--json`, `--jsonl`, `--quiet`, `--verbose`, `--force`, and `--no-cache`. Help and version use result envelopes with JSON output. Normal JSON always has one final success-or-error envelope; progress events are emitted only with `--jsonl`.

## Commands

| Command                     | Output                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `probe`                     | fingerprinted `video-probe` artifact                                                                 |
| `audio --output <path>`     | fingerprinted `video-audio` artifact                                                                 |
| `filmstrip --output <path>` | fingerprinted `video-filmstrip` artifact, including the referenced image bytes                       |
| `subtitles`                 | canonical fingerprinted `Transcript`                                                                 |
| `content summary`           | `video-content-summary` artifact                                                                     |
| `content keywords`          | `video-content-keywords` artifact                                                                    |
| `content highlights`        | `video-content-highlights` artifact                                                                  |
| `analyze`                   | exactly the supplied probe, audio, filmstrip, subtitles, summary, keywords, and highlights artifacts |

The machine-readable command list is [commands.json](./commands.json). There is no `generate` command or API.

## Artifact safety and programmatic APIs

The eight exported APIs are `probeVideo`, `extractVideoAudio`, `createVideoFilmstrip`, `extractVideoSubtitles`, `summarizeVideoContent`, `extractVideoKeywords`, `extractVideoHighlights`, and `analyzeVideo`.

Every video wrapper carries the SHA-256 fingerprint of the source video. `extractVideoSubtitles` extracts a temporary local audio file, calls the public `transcribeAudio` API with an explicitly injected `AudioTranscriber`, validates that audio transcript, then returns a canonical `Transcript` relinked to the video source. Without an injected transcriber it returns `AUDIO_TRANSCRIBER_UNAVAILABLE`; raw video/audio is never sent to a generic chat endpoint and no transcript is invented.

Filmstrip output is non-destructive: an existing output path is rejected with `OUTPUT_EXISTS` unless `--force` is set (or `force: true` is supplied to the API), which permits it to be overwritten.

Content APIs require a canonical `Transcript` and a `video-filmstrip` artifact whose source fingerprints match the requested video. A mix of artifacts from different videos returns `ARTIFACT_SOURCE_MISMATCH`. Their provider tasks use the exact feature IDs `video.content.summary`, `video.content.keywords`, and `video.content.highlights`, with timestamped transcript text and the filmstrip image attached as referenced visual content.

`analyzeVideo` never generates prerequisites. It accepts only explicitly supplied probe, audio, filmstrip, subtitles, summary, keywords, and highlights artifacts. Any omitted artifact returns `MISSING_REQUIRED_ARTIFACT`.

## AI configuration

Content commands load an explicit JSON profile with `--config`; the CLI never reads or prints environment secrets.

```json
{
  "profiles": [
    {
      "id": "video-content",
      "provider": "openai-compatible",
      "features": ["video.content.*"],
      "config": {
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "replace-with-a-secret",
        "model": "example-model"
      }
    },
    {
      "id": "azure-video-highlights",
      "provider": "azure",
      "features": ["video.content.highlights"],
      "config": {
        "endpoint": "https://example.openai.azure.com",
        "apiKey": "replace-with-a-secret",
        "deployment": "video-deployment",
        "apiVersion": "2024-10-21"
      }
    }
  ]
}
```

Profiles have unique IDs and one or more exact or `.*` feature routes; the first matching route is used. Missing or malformed configuration returns the sanitized typed error `AI_CONFIGURATION_INVALID`.

```bash
pnpm --filter @dkplus/dk-video build
pnpm --filter @dkplus/dk-video test
pnpm --filter @dkplus/dk-video typecheck
pnpm --filter @dkplus/dk-video lint
```
