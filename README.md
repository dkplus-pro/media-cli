# Monorepo Template

A pnpm + Turborepo monorepo template with shared configuration packages, a Modern.js React demo app, CI scripts, tests, and GitHub Pages deployment.

## GitHub Pages

- Demo URL template: [https://OWNER.github.io/REPOSITORY/](https://OWNER.github.io/REPOSITORY/)
- After creating your GitHub repository, replace `OWNER` and `REPOSITORY` with your real GitHub org/user and repo name.
- Enable **Settings → Pages → Build and deployment → Source: GitHub Actions**. The workflow in `.github/workflows/pages.yml` builds `apps/demo` and deploys `apps/demo/dist`.

## What's included

```text
apps/
  demo/                  Modern.js React hello-world app
packages/
  tsconfig/              Shared TypeScript presets
  eslint-config/         Shared ESLint flat config
  prettier-config/       Shared Prettier config
  commitlint-config/     Shared Commitlint config
scripts/
  ci.sh                  Full CI pipeline helper
  verify.sh              Fast local verification helper
  deploy-github-pages.sh Build and validate Pages artifact
.github/workflows/
  ci.yml                 Lint, typecheck, test, build
  pages.yml              GitHub Pages deployment
tests/
  jest/                  Repository and script unit tests
  playwright/            Demo app browser smoke test
```

## Requirements

- Node.js `>=20.19.5` (Node 22 LTS recommended; `.nvmrc` uses `lts/jod`)
- pnpm via Corepack (`packageManager` pins pnpm)

```bash
corepack enable
node --version
pnpm --version
```

## Install

```bash
pnpm install
```

## Start the demo app

```bash
pnpm dev
```

The Modern.js demo runs at <http://localhost:8080/> by default.

To run only the demo workspace:

```bash
pnpm --filter @dk-media/demo run dev
```

## Development commands

```bash
pnpm lint          # Turbo workspace lint + root ESLint
pnpm typecheck     # TypeScript checks across workspaces
pnpm test          # Jest + workspace tests + Playwright smoke test
pnpm build         # Build all buildable workspaces
pnpm format        # Check Prettier formatting
pnpm format:write  # Fix Prettier formatting
pnpm verify        # Fast local verification helper
pnpm ci            # CI helper: install + lint + typecheck + test + build
```

## Git hooks and commits

Husky is installed through the root `prepare` script.

- `pre-commit`: runs `lint-staged`
- `commit-msg`: runs Commitlint using the shared conventional commit config

Use conventional commit messages such as:

```bash
git commit -m "feat: add shared ui package"
```

## Tests

- Jest unit tests live in `tests/jest`.
- Playwright E2E tests live in `tests/playwright` and start the Modern.js demo automatically.
- The app also has a lightweight Node test under `apps/demo/tests`.

For a first Playwright run locally, install the Chromium browser:

```bash
pnpm exec playwright install chromium
pnpm run test:e2e
```

## GitHub Pages deployment

Local artifact build:

```bash
GITHUB_PAGES_BASE_PATH=/REPOSITORY pnpm run build:pages
```

This builds `apps/demo/dist` and verifies that `index.html` is at the artifact root. In GitHub Actions, `pages.yml` sets `GITHUB_PAGES_BASE_PATH` from the repository name and uploads `apps/demo/dist` with the official Pages artifact action.

## Adding more workspaces

- Add applications under `apps/*`.
- Add shared packages under `packages/*`.
- Add package-level scripts named `build`, `lint`, `typecheck`, and `test` so Turborepo can schedule them.
