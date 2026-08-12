# Phase-one Media CLI

Phase one provides 21 command-line operations: six audio, eight video, and
seven image. The public packages are `@dkplus/dk-audio`,
`@dkplus/dk-video`, and `@dkplus/dk-image`; their binaries are `dk-audio`,
`dk-video`, and `dk-image`.

Image and video generation are explicitly out of scope. There is no
`generate` command or generation API in phase one; image generation remains a
phase-two design concept only.

## Prerequisites

Install Node.js `>=20.19.5`, pnpm through Corepack, and `ffmpeg` plus
`ffprobe` on `PATH`. FFmpeg/ffprobe support local audio/video metadata,
audio extraction, and video filmstrips. Programmatic callers of media-core can
override the executable paths; CLI users should make both commands available
on `PATH`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

## Command contract

Every binary supports these global flags:

| Flag               | Meaning                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `--help` (`-h`)    | Show usage and command help.                                      |
| `--version` (`-V`) | Show the CLI version.                                             |
| `--schema`         | Return the selected command's input/output schema.                |
| `--config <path>`  | Load an explicit JSON AI-profile file where the command needs AI. |
| `--json`           | Emit one final JSON result envelope.                              |
| `--jsonl`          | Emit JSON Lines progress events followed by one result envelope.  |
| `--quiet`          | Suppress non-essential diagnostics.                               |
| `--verbose`        | Emit verbose diagnostics.                                         |
| `--force`          | Permit an explicitly overwriteable output operation.              |
| `--no-cache`       | Disable cached results.                                           |

`--json` and `--jsonl` are mutually exclusive. `--schema --json` is the
machine-readable way to discover a command without maintaining a separate
client-side schema copy. Help and version also use the result envelope when a
JSON output mode is selected.

Normal stdout is exactly one JSON envelope; diagnostics belong on stderr.
Successful commands exit `0`; failures exit `1`.

```json
{
  "success": true,
  "command": "music metadata",
  "version": "0.1.0",
  "data": {}
}
```

```json
{
  "success": false,
  "command": "music metadata",
  "version": "0.1.0",
  "error": {
    "code": "MEDIA_TOOL_UNAVAILABLE",
    "message": "Required media tool is unavailable."
  }
}
```

With `--jsonl`, progress records have the shape
`{"type":"progress","stage":"execute"}` before the final envelope.

## Commands

### Audio — 6 commands

| Command                                                           | Required input/options   | Result                               |
| ----------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| `dk-audio speech transcribe <audio>`                              | raw audio adapter        | Canonical, fingerprinted transcript. |
| `dk-audio speech translate <transcript-or-audio> --to <language>` | `--to`                   | Translated canonical transcript.     |
| `dk-audio speech summarize <transcript>`                          | AI profile               | Typed summary.                       |
| `dk-audio music metadata <audio>`                                 | local `ffprobe`          | Deterministic audio metadata.        |
| `dk-audio music emotion <audio>`                                  | AI profile               | Typed music emotion.                 |
| `dk-audio music analyze <audio>`                                  | AI profile and `ffprobe` | Exactly `{ metadata, emotion }`.     |

Raw-audio behavior is adapter-only. `speech transcribe` requires an injected
raw-audio transcriber; `speech translate <audio>` composes that transcriber
with an injected transcript translator. Neither operation sends raw audio to a
Qwen-compatible chat endpoint, and neither is enabled merely by `--config`.
Transcript translation and summary consume the canonical transcript contract.

### Video — 8 commands

| Command                                                                                                                                               | Required input/options         | Result                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| `dk-video probe <video>`                                                                                                                              | local `ffprobe`                | Fingerprinted video-probe artifact.            |
| `dk-video audio <video> --output <audio>`                                                                                                             | `ffmpeg`, output               | Fingerprinted extracted-audio artifact.        |
| `dk-video filmstrip <video> --output <image>`                                                                                                         | `ffmpeg`, output               | Four-frame fingerprinted filmstrip artifact.   |
| `dk-video subtitles <video>`                                                                                                                          | `ffmpeg`, raw-audio adapter    | Canonical transcript.                          |
| `dk-video content summary <video> --transcript <json> --filmstrip <json>`                                                                             | matching artifacts, AI profile | Video content summary artifact.                |
| `dk-video content keywords <video> --transcript <json> --filmstrip <json>`                                                                            | matching artifacts, AI profile | Video content keywords artifact.               |
| `dk-video content highlights <video> --transcript <json> --filmstrip <json>`                                                                          | matching artifacts, AI profile | Timestamped highlights artifact.               |
| `dk-video analyze <video> --probe <json> --audio <json> --filmstrip <json> --subtitles <json> --summary <json> --keywords <json> --highlights <json>` | all listed artifacts           | Composite of exactly those supplied artifacts. |

`subtitles` extracts temporary audio and then requires the same injected
raw-audio transcriber as audio transcription. Content artifacts must have the
requested video's source fingerprint; mixed sources fail with
`ARTIFACT_SOURCE_MISMATCH`. `analyze` never creates prerequisites: missing
inputs fail with `MISSING_REQUIRED_ARTIFACT`. Filmstrip outputs refuse to
overwrite an existing path unless `--force` is supplied.

### Image — 7 commands

| Command                                                     | Required input/options   | Result                                                   |
| ----------------------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `dk-image content metadata <image>`                         | local image file         | Deterministic metadata.                                  |
| `dk-image content describe <image>`                         | AI profile               | Image description.                                       |
| `dk-image content keywords <image>`                         | AI profile               | Keywords.                                                |
| `dk-image content ocr <image>`                              | AI profile               | Visible text and blocks.                                 |
| `dk-image content score <image>`                            | AI profile               | Score from 0 through 10 and rationale.                   |
| `dk-image analyze <image>`                                  | AI profile               | Exactly metadata, description, keywords, OCR, and score. |
| `dk-image watermark <image> --output <image> --text <text>` | distinct output and text | Watermarked-image artifact.                              |

Watermarking is output-only: it refuses an existing output without `--force`
and always rejects an output path that resolves to the input image.

## AI profiles

AI-enabled CLI commands load only the JSON file named by `--config`; they do
not read or print process environment credentials. Keep the file outside source
control and replace placeholders through your secret-management workflow. A
profile has a unique `id`, exact feature IDs or `.*` feature patterns, and an
`azure` or `openai-compatible` provider. The first matching feature route is
used.

```json
{
  "profiles": [
    {
      "id": "azure-content",
      "provider": "azure",
      "features": ["audio.speech.summarize", "video.content.*", "image.content.*"],
      "config": {
        "endpoint": "https://YOUR_RESOURCE.openai.azure.com",
        "apiKey": "<AZURE_OPENAI_API_KEY>",
        "deployment": "<AZURE_OPENAI_DEPLOYMENT>",
        "apiVersion": "2024-10-21"
      }
    },
    {
      "id": "qwen-content",
      "provider": "openai-compatible",
      "features": ["audio.music.*"],
      "config": {
        "baseUrl": "<DASHSCOPE_BASE_URL>",
        "apiKey": "<DASHSCOPE_API_KEY>",
        "model": "<DASHSCOPE_MODEL>"
      }
    }
  ]
}
```

The current live-test providers recognize these environment variables (never
put their values in documentation or committed config):

| Provider        | Canonical names                                                                                        | Accepted aliases                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Azure OpenAI    | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` | `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_MODEL`, `AZURE_OPENAI_VERSION` |
| Qwen-compatible | `DASHSCOPE_BASE_URL`, `DASHSCOPE_API_KEY`, `DASHSCOPE_MODEL`                                           | `QWEN_BASE_URL`, `QWEN_API_KEY`, `QWEN_MODEL`                                             |

## Testing and package verification

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:live
pnpm test:smoke
```

`pnpm test:live` is safe by default: every live provider case is skipped unless
`DKPLUS_LIVE_AI=1` is already injected into the environment. When enabled, the
Azure and Qwen-compatible variables above must be supplied externally. Do not
paste credentials into a command, profile example, test output, or issue.
Raw-audio transcription and direct-audio translation are deliberately outside
the Qwen-compatible chat live matrix until a dedicated ASR profile exists.

`pnpm test:smoke` builds the public packages, packs every public package,
installs those archives in a disposable offline consumer, verifies package
contents, and runs `dk-audio --help`, `dk-image --help`, and `dk-video --help`
from that installed consumer. CI runs this non-live smoke check after its
format, lint, typecheck, test, and build stages; it never runs `test:live`.
