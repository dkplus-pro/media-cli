# 阶段 04 — 自省与示例插件（introspection & example plugin）

> 前置依赖：阶段 03。目标：`spec` 自省命令（AI 可自发现全部能力）、`hello` 示例插件（业务接入模板）、插件开发指南文档。

## 范围

做：`spec` 内置命令、`plugins/hello/` 示例插件、`docs/plugin-development.md`。
不做：插件发布到 node_modules 的发现机制（未来演进，登记 master-plan 决策表即可）。

## 任务清单

### T1 `src/commands/builtin/spec.ts`

- 无位置参数；`--json` 输出，human 输出可读树。
- data 结构（即 spec schema）：

```jsonc
{
  "name": "common-cli",
  "version": "0.1.0",
  "commands": [
    {
      "name": "version", "description": "...", "source": "builtin",
      "options": [ { "flags": "...", "description": "..." } ]
    }
    // 插件命令 source 为 "plugin:<name>"；按注册顺序（内置在前）
  ],
  "exitCodes": { "0": "成功", "1": "未捕获/内部错误", "2": "用法类错误", "3": "命令执行错误", "4": "保留" },
  "errorCodes": [ "E_USAGE", "..." ]   // 从 core/errors.ts 导出常量生成，保持单一事实源
}
```

- spec 自身也必须出现在 commands 列表中（自描述）。错误码常量需从 `src/core/errors.ts` 导出数组 `CLI_ERROR_CODES`（登记表），spec 引用它。

### T2 示例插件 `plugins/hello/index.mjs`

```js
export default {
  name: "hello",
  version: "0.1.0",
  commands: [
    {
      name: "hello",
      description: "Greet via the example plugin (business feature template)",
      options: [{ flags: "--name <name>", description: "Who to greet (default: world)" }],
      handler: (ctx, args) => ({ message: `hello, ${args.name ?? "world"}!` })
    }
  ]
};
```

该文件同时是 `docs/plugin-development.md` 的引用模板，必须保持极简。

### T3 `docs/plugin-development.md`（插件开发指南）

结构：定位 → 30 秒上手（目录 + index.mjs 模板）→ manifest 字段说明 → options 语法（commander flags 字符串）→ handler 契约（return 数据 / throw CliError；禁止写流、禁止 prompt）→ 本地调试（`COMMON_CLI_PLUGINS_DIR`）→ 校验规则与常见警告码 → 完整示例引用 `plugins/hello/index.mjs`。
要求：按此指南新建一个插件不需要读源码。

## Agent 分工（可并行）

- **coding-agent A**：T1 spec 命令（含 `CLI_ERROR_CODES` 导出与 core/errors.ts 增量）
- **coding-agent B**：T2 hello 插件 + T3 指南文档 + e2e `tests/e2e/spec.e2e.test.ts`（覆盖 spec schema 断言：含 version/spec/hello、source 正确、errorCodes 含 E_USAGE）

## 验收标准（test-agent 执行）

```bash
pnpm lint && pnpm build && pnpm test
node dist/common-cli.js --json spec       # 退出 0；JSON 含 version/spec/hello 命令；errorCodes 含 E_USAGE
node dist/common-cli.js spec              # human 模式输出命令树
node dist/common-cli.js --json hello --name AI   # 退出 0；data.message === "hello, AI!"
node dist/common-cli.js --json hello      # data.message === "hello, world!"
pnpm test                                  # 全绿
```
