# common-cli

通用 Node CLI 壳：给人用，也给 AI 用。本仓库不含具体业务功能，业务能力以**插件**形式接入（见 [插件开发指南](docs/plugin-development.md)）。

- 方案记录与架构决策：[docs/plans/00-master-plan.md](docs/plans/00-master-plan.md)
- 架构硬约束（协作者必读）：[AGENTS.md](AGENTS.md)
- 阶段执行文档：[docs/plans/01](docs/plans/01-repo-foundation.md) · [02](docs/plans/02-core-shell-and-contracts.md) · [03](docs/plans/03-plugin-system.md) · [04](docs/plans/04-introspection-and-example.md) · [05](docs/plans/05-testing-and-hardening.md)

## 快速开始

```bash
pnpm install
pnpm build
node dist/common-cli.js --help        # 人类友好帮助
node dist/common-cli.js --json spec   # AI 自省：完整命令树 JSON
node dist/common-cli.js --json hello --name AI   # 示例插件命令
```

## 人/AI 双契约（摘要）

- `--json`：stdout 有且只有一个 JSON 包络 `{ ok, data | error, warnings }`，可直接 `JSON.parse`
- stdout 只出数据，stderr 只出日志/警告；错误码 `E_*` 稳定，退出码成文
- 壳永不交互式提问，缺参数直接结构化报错——AI/脚本调用永不挂起

## 开发

```bash
pnpm dev -- --json version   # tsx 直跑源码
pnpm lint && pnpm test       # Biome + Vitest（e2e spawn dist 真进程）
```

技术底座：TypeScript + tsup（纯 ESM）· commander · pnpm · Biome · Vitest · Node >= 20。
