# dkplus Media CLI

`dkplus Media CLI` is a pnpm/Turborepo workspace for three publishable,
machine-oriented media CLIs:

- `@dkplus/dk-audio` — six audio commands
- `@dkplus/dk-video` — eight video commands
- `@dkplus/dk-image` — seven image commands

Phase one implements 21 non-generative commands. It deliberately does **not**
expose image or video generation.

## Documentation

- [English phase-one CLI guide](docs/en/phase-one-cli.md)
- [简体中文第一阶段 CLI 指南](docs/zh-CN/phase-one-cli.md)
- [Architecture and future-phase design](docs/DESIGN.md)

## Requirements and install

- Node.js `>=20.19.5` (Node 22 LTS recommended)
- pnpm `>=10.1.0` through Corepack
- `ffmpeg` and `ffprobe` on `PATH` for audio/video probing, extraction, and
  filmstrips; programmatic media-core callers can override their executable
  paths.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build

# Run a workspace binary during development.
pnpm --filter @dkplus/dk-audio exec dk-audio --help
```

All CLIs emit a single JSON success-or-error envelope to stdout. Use `--help`
for usage and `--schema --json` to inspect an individual command contract.

## Development and verification

```bash
pnpm format       # Prettier check only
pnpm lint
pnpm typecheck
pnpm test         # Jest, workspace tests, and Playwright; never live providers
pnpm build
pnpm test:live    # Skips unless DKPLUS_LIVE_AI=1 is explicitly set
pnpm test:smoke   # Packs every public package, installs a disposable consumer, runs CLI help
```

CI installs with a frozen lockfile, keeps Playwright browser preparation, and
runs formatting, linting, typechecks, non-live tests, builds, and the package
consumer smoke test. It never invokes `test:live`.

## Repository layout

```text
packages/contracts/   Shared result, error, artifact, and transcript contracts
packages/cli-core/    Shared flags, schemas, command runner, JSON/JSONL output
packages/ai-core/     Feature routing plus Azure/OpenAI-compatible providers
packages/media-core/  FFmpeg/ffprobe and image adapters
packages/testing/     Deterministic fixtures and test helpers
packages/dk-audio/    Publishable dk-audio package and binary
packages/dk-image/    Publishable dk-image package and binary
packages/dk-video/    Publishable dk-video package and binary
```
