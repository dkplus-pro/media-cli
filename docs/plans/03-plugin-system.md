# 阶段 03 — 插件系统（plugin system）

> 前置依赖：阶段 02。目标：本地目录插件发现、manifest 手写校验、动态加载、声明式命令挂载、失败警告并继续。
> 契约全文见 `00-master-plan.md` §5。

## 范围

做：`src/plugins/**` 全部、插件 fixture、插件 e2e/unit 测试。
不做：spec 自省与 hello 示例（04）。

## 任务清单

### T1 `src/plugins/types.ts`

```ts
import type { CommandDefinition, RunContext } from "../core/types.js";
export interface PluginCommandDef {
  name: string; description: string;
  options?: { flags: string; description: string }[];
  handler: (ctx: RunContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}
export interface PluginManifest {
  name: string; version: string; commands: PluginCommandDef[];
}
```

### T2 `src/plugins/discover.ts`

- 目录解析顺序（先到先得）：`process.env.COMMON_CLI_PLUGINS_DIR`（`:` 分隔，可为相对路径）→ 项目 `<cwd>/plugins/`（存在才计入）→ `~/.common-cli/plugins/`（存在才计入）。
- 每个插件目录的入口固定为 `index.mjs`；不存在则视为 `E_PLUGIN_LOAD_FAILED` 候选（交 loader 报警告）。
- 返回按优先级排序的候选列表 `{ dir, source: "env" | "project" | "global" }[]`；同名 manifest 去重在 loader 按 name 处理。

### T3 `src/plugins/manifest.ts`（手写校验）

`validatePluginExport(value: unknown): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] }`
规则：非空对象；`name` 匹配 `^[a-z][a-z0-9-]*$`；`version` 非空字符串；`commands` 为数组；每个 command：`name` 非空字符串且与插件名不同名不限制、`description` 非空字符串、`options` 可选数组（每项 flags/description 非空字符串）、`handler` 为函数。错误信息带字段路径（如 `commands[0].handler`）。

### T4 `src/plugins/loader.ts`

- `loadPlugins(ctx, registry): Promise<void>`：
  1. 依次 `await import(pathToFileURL(entry).href)`（try/catch → warning `E_PLUGIN_LOAD_FAILED`，带 plugin 目录名）；
  2. `validatePluginExport(mod.default)` 失败 → warning `E_PLUGIN_MANIFEST_INVALID`（错误清单并入 message）；
  3. manifest.name 已出现过 → warning `E_PLUGIN_DUPLICATE`，跳过（保持高优先级来源）；
  4. 每个 command 经 `registry.register(def, `plugin:${manifest.name}`)`；返回 `ok:false` → warning `E_PLUGIN_COMMAND_CONFLICT`（plugin 字段为插件名）；
  5. 全程不抛出、不中断；所有失败都进 `ctx.warnings`。
- 插件 `PluginCommandDef` → `CommandDefinition` 的映射保持字段直传（options 的 defaultValue 不在此阶段支持）。

## 测试任务

### fixtures（`tests/fixtures/plugins/`）

- `good/index.mjs`：命令 `plugin-echo`，选项 `--text <text>`，handler 返回 `{ text: args.text ?? "default" }`
- `bad-syntax/index.mjs`：语法错误文件（用于加载失败路径）
- `bad-manifest/index.mjs`：缺 `name`、handler 非函数（用于校验失败路径）
- `dup/index.mjs`：与 good 同名 `good`（用于 duplicate 路径；测试里放低优先级目录）

### `tests/unit/manifest.test.ts` + `tests/e2e/plugins.e2e.test.ts`

e2e 用 `COMMON_CLI_PLUGINS_DIR` 指向 fixtures，spawn dist 进程验证：

- `--json plugin-echo --text hi` → `{ok:true,data:{text:"hi"}}`，warnings 空或不含插件错误
- `--json plugin-echo`（缺参不缺省）→ 仍成功返回 default（该插件无必填）
- 同时加载 good+bad-syntax+bad-manifest → 命令仍可用，`warnings` 数组包含 `E_PLUGIN_LOAD_FAILED` 与 `E_PLUGIN_MANIFEST_INVALID`，退出码 0
- 项目 `./plugins/` 与 env 同名时项目/env 优先（duplicate 警告出现，低优先级插件命令不可用）

## Agent 分工（可并行）

- **coding-agent A**：`src/plugins/**`（T1–T4）
- **coding-agent B**：fixtures + `tests/unit/manifest.test.ts` + `tests/e2e/plugins.e2e.test.ts`（按本文契约先行编写）
- 冲突面：A 不改 tests，B 不改 src；接口以本文为准。

## 验收标准（test-agent 执行）

```bash
pnpm lint && pnpm build && pnpm test
COMMON_CLI_PLUGINS_DIR=tests/fixtures/plugins/good node dist/common-cli.js --json plugin-echo --text hi
# 退出 0；stdout: {"ok":true,"data":{"text":"hi"},"warnings":[]}
COMMON_CLI_PLUGINS_DIR="tests/fixtures/plugins/good:tests/fixtures/plugins/bad-syntax:tests/fixtures/plugins/bad-manifest" \
  node dist/common-cli.js --json plugin-echo
# 退出 0；warnings 含 E_PLUGIN_LOAD_FAILED、E_PLUGIN_MANIFEST_INVALID
pnpm test   # 全绿
```
