# Phase-one Media CLI Implementation Plan

For agentic workers: use subagent-driven-development or executing-plans task-by-task.

Goal: Build the 21 non-generative phase-one commands specified in docs/DESIGN.md.

Architecture: Shared contracts, CLI infrastructure, AI routing, and media adapters sit below three publishable packages. Domain functions are reusable Node APIs; CLI adapters only parse arguments and serialize their results. dk-video may call public dk-audio APIs; no package may depend on dk-video.

Tech Stack: Node.js 24, TypeScript, pnpm, Turborepo, Commander, Zod, native fetch, FFmpeg/ffprobe, Sharp, Vitest.

## Global Constraints

- Add @dkplus/contracts, @dkplus/cli-core, @dkplus/ai-core, @dkplus/media-core, @dkplus/testing, and public @dkplus/dk-audio, @dkplus/dk-video, @dkplus/dk-image packages.
- Every binary supports help, version, config, json, jsonl, quiet, verbose, force, and no-cache options. JSON stdout is a single envelope and logs use stderr.
- Features route through profiles; domain packages never read API keys or provider URLs.
- Normal tests use mock AI. Live provider tests require DKPLUS_LIVE_AI=1 and never print secret values.
- music analyze combines only metadata and emotion; image analyze excludes category; no image or video generation command is added.
- FFmpeg and ffprobe are PATH prerequisites, overridable by configuration.

### Task 1: Verify a clean toolchain baseline

Files: no tracked source changes; use the existing package manifests and frozen lockfile.

Produces: a reproducible healthy dependency installation before new production source lands.

- [x] Run pnpm install --frozen-lockfile in the isolated worktree.
- [x] Run pnpm lint and pnpm test; both must exit 0 before feature work starts.
- [ ] If a separate checkout fails with the same lockfile, remove and reinstall only that checkout's untracked node_modules; do not change dependency versions without a reproducing clean-install failure.
- [x] Record the verified Node and pnpm versions in the implementation ledger.

### Task 2: Add contracts and CLI-core

Files: create packages/contracts source for cli, errors, artifacts, audio, image, video, index; create packages/cli-core source for command, options, output, schema, index; add package manifests, tsconfigs, and focused tests.

Produces: CliResult, CliError, Transcript, artifact fingerprints, CommandDescriptor, runCommand, emitResult, emitProgress, and describeCommands.

- [x] Test a stable success envelope and a typed IMAGE_NOT_FOUND failure envelope.
- [x] Run package tests; expect unresolved exports.
- [x] Implement a versioned Transcript with sourceFingerprint and timestamped segments, plus a single success-or-error result envelope.
- [x] Verify contracts and CLI-core tests plus typecheck.
- [x] Commit: feat: add shared cli contracts.

### Task 3: Add ai-core and providers

Files: create packages/ai-core source for task types, config, feature resolver, mock provider, OpenAI-compatible provider, Azure provider, index, tests, manifest, and tsconfig.

Produces: AIProvider.execute(task), FeatureResolver.resolve(feature), mock, Azure GPT-4o, and Qwen-compatible providers.

- [ ] Test that audio.speech.summarize resolves to an Azure profile and Azure sends api-key auth to the configured deployment chat-completions endpoint.
- [ ] Run ai-core tests; expect missing modules.
- [ ] Implement typed tasks with feature, prompt, optional images, and Zod parsing. Azure treats the configured model as its deployment and calls openai/deployments/{deployment}/chat/completions with a configurable API version; Qwen uses Bearer auth at baseUrl/chat/completions.
- [ ] Support canonical Azure variables AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT, and AZURE_OPENAI_API_VERSION plus compatible aliases AZURE_OPENAI_KEY and AZURE_OPENAI_MODEL. Support DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL, and DASHSCOPE_MODEL plus compatible QWEN_API_KEY and QWEN_BASE_URL aliases; default the compatible text model only when the profile supplies no model.
- [ ] Verify all provider tests use stubbed fetch and read no real environment values.
- [ ] Commit: feat: add ai feature routing.

### Task 4: Add media-core and fixtures

Files: create packages/media-core source for process, fingerprint, audio, video, image, watermark, index; create packages/testing source and short audio/video/image fixtures; add adapter tests.

Produces: probeAudio, probeVideo, extractAudio, createFilmstrip, loadImage, readImageMetadata, watermarkImage, and fingerprintFile.

- [ ] Test video probe, a two-by-two filmstrip with four frames, and watermark output dimensions.
- [ ] Run media-core tests; expect absent adapters and fixtures.
- [ ] Implement shell-free FFmpeg and ffprobe spawning; map failures to MEDIA_TOOL_UNAVAILABLE or MEDIA_PROCESS_FAILED; use Sharp for static JPEG, PNG, and WebP.
- [ ] Verify deterministic media tests without network access.
- [ ] Commit: feat: add deterministic media core.

### Task 5: Build dk-audio

Files: create packages/dk-audio source for speech, music, cli, index; add commands manifest, bilingual READMEs, manifest, tsconfig, tests.

Produces: speech transcribe, translate, summarize; music metadata, emotion, analyze. Exports: transcribeAudio, translateTranscript, summarizeTranscript, readAudioMetadata, analyzeMusicEmotion, analyzeMusic.

- [ ] Test schemas and contracts for all six APIs, including that analyzeMusic returns only metadata and emotion.
- [ ] Run dk-audio tests; expect missing exports.
- [ ] Implement canonical transcript parsing and serialization, deterministic metadata with null unavailable music values, and feature-routed AI summary/emotion.
- [ ] Add CLI tests for JSON, schema, malformed input, and non-zero failures.
- [ ] Verify test, build, and pack dry-run; commit: feat: add audio cli phase one.

### Task 6: Build dk-image without generation

Files: create packages/dk-image source for content, watermark, cli, index; add commands manifest, bilingual READMEs, manifest, tsconfig, tests.

Produces: content metadata, describe, keywords, ocr, score, analyze, watermark.

- [ ] Test that analyzeImage combines exactly metadata, description, keywords, ocr, score and watermark rejects an existing output without force.
- [ ] Run dk-image tests; expect missing exports.
- [ ] Implement image asset loading, Feature IDs image.content.describe, keywords, ocr, score, score range validation [0, 10], and non-destructive output-only watermarking.
- [ ] Verify every CLI command exposes schema and commands manifest does not expose generate.
- [ ] Verify test, build, and pack dry-run; commit: feat: add image cli phase one.

### Task 7: Build dk-video

Files: create packages/dk-video source for media, content, analyze, cli, index; add commands manifest, bilingual READMEs, manifest, tsconfig, tests.

Produces: probe, audio, filmstrip, subtitles, content summary, content keywords, content highlights, analyze.

- [ ] Test source-fingerprint matching and assert mixed transcript/filmstrip artifacts fail with ARTIFACT_SOURCE_MISMATCH.
- [ ] Run dk-video tests; expect missing exports.
- [ ] Implement video media wrappers; subtitles extract audio then call public transcribeAudio. Content uses timestamped transcript and frames through video content Feature IDs.
- [ ] Implement composite analyze dependencies: only supplies prerequisites; a skipped prerequisite causes MISSING_REQUIRED_ARTIFACT; JSONL is the only progress mode.
- [ ] Verify test, build, and pack dry-run; commit: feat: add video cli phase one.

### Task 8: Add opt-in live AI and consumer smoke tests

Files: add live tests in ai-core, dk-audio, dk-image, dk-video; modify root scripts and apps/demo package manifest.

Produces: pnpm test:live, skipped unless DKPLUS_LIVE_AI=1.

- [ ] Test that live tests skip with no live flag.
- [ ] Run pnpm test:live; expect exit 0 with skipped live cases.
- [ ] Add Azure GPT-4o text summary, one-image description, and transcript-plus-filmstrip video summary tests. Add a Qwen-compatible safe text-analysis test.
- [ ] Keep raw audio transcription and direct-audio translation out of the Qwen-compatible Chat live matrix; they remain feature-configurable and mock-covered until a dedicated ASR profile is configured.
- [ ] Assert schemas and non-empty required fields only; redact provider errors and never snapshot prose.
- [ ] Pack each public package into an ignored temporary directory and run its installed binary with help; commit: test: add live ai provider coverage.

### Task 9: Document and verify phase one

Files: modify README.md, docs/DESIGN.md, .github/workflows/ci.yml, tests/jest/repository-structure.test.cjs; create docs/en/phase-one-cli.md and docs/zh-CN/phase-one-cli.md.

Produces: bilingual human/agent documentation and CI validation for format, lint, typecheck, tests, builds, and package contents.

- [ ] Test that every new workspace package has a manifest.
- [ ] Run root test before packages exist; expect failure.
- [ ] Document all 21 commands, output envelope, profile variable names, FFmpeg prerequisite, opt-in live test, and generation exclusion.
- [ ] Configure CI to omit live tests and run pack dry-runs for all public packages.
- [ ] Run format, lint, typecheck, test, build, then live tests only with externally injected credentials.
- [ ] Commit: docs: document phase one media cli.

## Plan Self-review

- Covers all first-phase commands: Audio 6, Video 8, Image 7.
- Shared packages precede domains, preventing concurrent conflicts.
- Azure covers text and image summary behavior; Qwen covers an opt-in compatible provider path.
- The plan explicitly excludes image and video generation.
