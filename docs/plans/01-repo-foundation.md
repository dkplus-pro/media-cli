# 阶段 01 — 仓库底座（repo foundation)

> 前置依赖：无。目标：仓库可安装、可构建、可 lint，bin 最小可跑（`--version`）。
> 硬约束见根目录 `AGENTS.md`，本文只写本阶段增量。

## 范围

做：构建与质量工具配置、最小入口。不做：任何命令实现、插件机制、输出契约（02–04）。

## 任务清单

### T1 包配置 `package.json`

- `name: "common-cli"`，`version: "0.1.0"`，`private: true`，`type: "module"`，`engines: { node: ">=20" }`
- `bin: { "common-cli": "dist/common-cli.js" }`
- `files: ["dist"]`
- scripts：
  - `build`: `tsup`
  - `dev`: `tsx src/bin/common-cli.ts`
  - `lint`: `biome check .`
  - `format`: `biome check --write .`
  - `test`: `pnpm -s build && vitest run`
  - `prepare`: `simple-git-hooks`
- devDependencies（版本取 pnpm 最新兼容）：typescript、tsup、tsx、@biomejs/biome、vitest、simple-git-hooks、lint-staged
- lint-staged 配置：`"*.{ts,js,mjs,json,md}"`: `biome check --write`；simple-git-hooks：`pre-commit: pnpm lint-staged`

### T2 TypeScript 配置 `tsconfig.json`

- `strict: true`、`target: "ES2022"`、`module: "NodeNext"`、`moduleResolution: "NodeNext"`、`resolveJsonModule: true`、`verbatimModuleSyntax: true`、`noUncheckedIndexedAccess: true`、`skipLibCheck: true`、`types: ["node"]`
- include：`src`、`tests`、`tsup.config.ts`；noEmit（构建交给 tsup）

### T3 构建配置 `tsup.config.ts`

- entry：`src/bin/common-cli.ts`；format：`["esm"]`；target：`node20`；`clean: true`；`splitting: false`；sourcemap：`true`
- shebang 由入口源码首行 `#!/usr/bin/env node` 自动保留

### T4 Biome 配置 `biome.json`

- formatter：2 空格、行宽 100、双引号；linter 默认规则；忽略 `dist`、`node_modules`、`pnpm-lock.yaml`
- `biome check`（lint+format 一步）

### T5 `.gitignore`

`node_modules/`、`dist/`、`*.log`、`.DS_Store`、coverage。

### T6 最小入口 `src/bin/common-cli.ts`

- 首行 shebang；仅调用 `main()`（本阶段可暂打印版本占位，02 阶段替换为真实编排）。文件行数 < 30。

## Agent 分工建议

配置文件互相耦合（package.json 被其余所有配置引用），**建议单 agent 串行完成 T1–T6**，另一 agent 待命；如需并行：A=T1+T4+T5（package.json/biome/gitignore），B=T2+T3+T6（tsconfig/tsup/入口），B 的 scripts 引用以 T1 为准。

## 验收标准（test-agent 执行）

```bash
pnpm install                      # 依赖安装成功，生成 pnpm-lock.yaml
pnpm lint                         # Biome 通过
pnpm build                        # 产出 dist/common-cli.js
node dist/common-cli.js --version # 输出 0.1.0，退出码 0
git status --short                # 仅预期文件
```
