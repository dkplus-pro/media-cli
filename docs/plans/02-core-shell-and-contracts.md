# 阶段 02 — 核心骨架与双契约（core shell & contracts）

> 前置依赖：阶段 01。目标：分层目录落地、错误模型、退出码、stdout/stderr 分离、`--json` 包络、声明式命令注册器、内置 `version` 命令、e2e 验证契约。
> 本文给出的接口签名是**并行开发的接口锁**，实现必须一致。

## 范围

做：core 全部机制、cli 装配、注册器与 `version` 内置命令、契约 e2e。
不做：插件机制（03）、spec 命令（04）。

## 接口定义（接口锁）

### `src/core/exit-codes.ts`

```ts
export const EXIT_CODES = { OK: 0, UNCAUGHT: 1, USAGE: 2, COMMAND: 3, PLUGIN_RESERVED: 4 } as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
```

### `src/core/errors.ts`

```ts
export type CliErrorCode =
  | "E_USAGE" | "E_COMMAND_NOT_FOUND" | "E_MISSING_ARGUMENT" | "E_INTERNAL"
  | "E_PLUGIN_MANIFEST_INVALID" | "E_PLUGIN_LOAD_FAILED"
  | "E_PLUGIN_COMMAND_CONFLICT" | "E_PLUGIN_DUPLICATE";
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details?: unknown;
  constructor(code: CliErrorCode, message: string, details?: unknown);
}
export function exitCodeForError(err: unknown): ExitCode;
// 规则：E_USAGE/E_COMMAND_NOT_FOUND/E_MISSING_ARGUMENT 及用法类 → 2；
//      其他 CliError → 3；非 CliError → 1（E_INTERNAL 包装）。
```

### `src/core/output/warnings.ts` / `logger.ts` / `writer.ts`

```ts
export interface Warning { code: string; message: string; plugin?: string }
export class WarningCollector {
  add(w: Warning): void; list(): readonly Warning[]; get isEmpty(): boolean;
}
export interface Logger { debug(msg: string): void; info(msg: string): void; warn(msg: string): void; error(msg: string): void }
// logger 一律写 stderr；--quiet 抑制 info/debug；--verbose 打开 debug；--json 默认全静默（--verbose 例外）
// 全仓库唯一允许触碰 process.stdout/stderr 的模块就是 core/output/*
export function writeResult(
  ctx: RunContext,
  result: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } },
): void;
// --json: stdout 输出单行 JSON 包络 {ok,data|error,warnings:ctx.warnings.list()}
// human:  data → console.log 风格写 stdout；error → `[error] [CODE] message` 写 stderr
```

### `src/core/types.ts`

```ts
export interface CommandOptionDef { flags: string; description: string; defaultValue?: string | boolean | number }
export interface CommandDefinition {
  name: string; description: string;
  options?: CommandOptionDef[];
  handler: (ctx: RunContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}
export interface RunContext {
  json: boolean; quiet: boolean; verbose: boolean; color: boolean; cwd: string;
  logger: Logger; warnings: WarningCollector;
}
```

### `src/commands/registry.ts`

```ts
export type CommandSource = "builtin" | `plugin:${string}`;
export interface RegisteredCommand { def: CommandDefinition; source: CommandSource }
export class CommandRegistry {
  register(def: CommandDefinition, source: CommandSource): { ok: boolean; warning?: Warning };
  get(name: string): RegisteredCommand | undefined;
  list(): readonly RegisteredCommand[];
  attachTo(program: Command, ctx: RunContext): void; // 每个定义生成 commander 子命令并包装 handler
}
```

`attachTo` 的 handler 包装：调 `def.handler(ctx, args)` → `writeResult(ctx, { ok: true, data })`；catch → `writeResult(ctx, { ok:false, error })` 并把退出码写入 `program.exitCode`（或抛出由 main 收敛，实现自定，但退出码必须符合 4.5 表）。

### `src/cli/options.ts`（全局选项预扫描）

```ts
export interface GlobalFlagSnapshot { json: boolean; quiet: boolean; verbose: boolean; color: boolean }
export function prescanGlobalFlags(argv: readonly string[]): GlobalFlagSnapshot;
// 识别 --json/--quiet/--verbose/--no-color 与 NO_COLOR 环境变量；跳过选项值；供插件加载期 logger 使用
```

### `src/cli/program.ts` 与 `src/cli/main.ts`

- program：name `common-cli`、版本号从 `package.json` 读取（`import pkg from "../../package.json" with { type: "json" }`，tsup 会内联）；`--json/--quiet/--verbose/--no-color` 注册为全局选项；`program.exitOverride()` 捕获 `CommanderError`，按其 code 映射：help/version → 退出 0（输出已由 commander 写 stdout）；unknownOption/invalidArgument → `E_USAGE` 退出 2；未知命令 → `E_COMMAND_NOT_FOUND` 退出 2。
- `main.ts`：`export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number>`，按 master-plan §3 总流程编排；最终把退出码交给 `src/bin` 调 `process.exitCode = code`。

### `src/commands/builtin/version.ts`

`version` 命令：无参数，data 返回 `{ name: "common-cli", version: <package.json version> }`。

## Agent 分工（接口已锁定，可并行）

- **coding-agent A**：`src/core/**` 全部 + 单元测试 `tests/unit/{errors,writer,logger}.test.ts`
- **coding-agent B**：`src/cli/**`、`src/commands/**`（registry、builtin/version、bin 入口接线）+ e2e `tests/e2e/contracts.e2e.test.ts`
- 冲突面：双方只 import 对方在本文声明的接口，不改对方文件。

## 验收标准（test-agent 执行）

```bash
pnpm lint && pnpm build
node dist/common-cli.js --version            # 退出 0，stdout 版本号
node dist/common-cli.js version             # human 模式，stdout 有版本信息
node dist/common-cli.js --json version      # stdout 可 JSON.parse，{ok:true,data:{name,version},warnings:[]}
node dist/common-cli.js --json nope         # 退出 2，stdout 包络 {ok:false,error.code:"E_COMMAND_NOT_FOUND"}
node dist/common-cli.js nope 2>/dev/null    # 退出 2，stdout 为空（错误在 stderr）
node dist/common-cli.js --json version --unknown-flag   # 退出 2，E_USAGE
pnpm test                                    # unit + e2e 全绿
```
