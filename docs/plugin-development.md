# 插件开发指南

common-cli 的业务能力以插件形式接入。按本指南新建一个插件**不需要读壳的源码**。

## 30 秒上手

1. 在项目 `plugins/` 目录（或全局 `~/.common-cli/plugins/`）下建一个子目录，目录名任意：
   ```
   plugins/hello/index.mjs
   ```
2. `index.mjs` 用 ESM 默认导出声明式 manifest（完整示例见仓库 `plugins/hello/index.mjs`）：
   ```js
   export default {
     name: "hello",
     version: "0.1.0",
     commands: [
       {
         name: "hello",
         description: "问候",
         options: [{ flags: "--name <name>", description: "要问候的对象（默认 world）" }],
         handler: (_ctx, args) => ({ message: `hello, ${args.name ?? "world"}!` }),
       },
     ],
   };
   ```
3. 跑起来：
   ```bash
   node dist/common-cli.js --json hello --name AI
   # {"ok":true,"data":{"message":"hello, AI!"},"warnings":[]}
   node dist/common-cli.js --json spec   # 新命令会出现在自省结果里
   ```

## manifest 字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | 是 | 匹配 `^[a-z][a-z0-9-]*$`；全局唯一，重复时高优先级来源胜出 |
| `version` | 是 | 非空字符串 |
| `commands` | 是 | 数组，可为空 |
| `commands[].name` | 是 | 非空字符串，**扁平命名空间**内全局唯一（与内置或其他插件命令重名会被跳过并警告） |
| `commands[].description` | 是 | 非空字符串（会出现在 `--help` 与 `spec`） |
| `commands[].options` | 否 | 数组；`flags` 是 commander 选项语法（如 `"--name <name>"`、`"--force"`），`description` 非空 |
| `commands[].handler` | 是 | `(ctx, args) => 数据 \| Promise<数据>` |

## handler 契约（硬约束）

- **只 return 数据**：返回值会成为 JSON 包络的 `data` 字段（human 模式下打印为文本）。
- **报错就 throw**：插件是纯 `.mjs`，无法 import 壳的 `CliError`，按**鸭子类型**携带已登记错误码抛出即可，壳会自动识别并归入对应退出码：
  ```js
  throw Object.assign(new Error("缺少 SUNO_API_KEY"), {
    code: "E_CONFIG",            // 必须是 spec 输出 errorCodes 里已登记的码
    details: { var: "SUNO_API_KEY" }, // 可选，会出现在 JSON 包络 error.details
  });
  ```
  常用业务语义码：`E_CONFIG`（配置缺失/非法）、`E_MISSING_DEPENDENCY`（外部二进制缺失，`details` 带安装提示）、`E_PROVIDER_ERROR`（外部提供方执行失败）。未登记的码或不带码的 Error 一律按 `E_INTERNAL` 处理（退出码 3）。
- **不要**直接写 stdout/stderr、不要调用 `process.exit`、不要调用任何交互式 prompt（AI/脚本调用会挂起）。输出一律由壳写入，这是人/AI 双契约的保证。
- `ctx` 提供 `logger`（stderr 日志）、`warnings`（结构化警告收集）、`json/quiet/verbose` 等运行旗标与 `cwd`。
- `args` 是已解析的选项键值对（如上例 `args.name`）；不需要 `ctx` 时形参写作 `_ctx`。

## 本地调试

- `COMMON_CLI_PLUGINS_DIR`（`:` 分隔）每一项即**单个插件目录**，优先级最高，适合指向任意实验目录：
  ```bash
  COMMON_CLI_PLUGINS_DIR=/tmp/my-plugin node dist/common-cli.js --json my-cmd
  ```
- 项目 `./plugins/` 与全局 `~/.common-cli/plugins/` 是**容器目录**（一级子目录 = 插件），优先级依次降低。

## 校验与常见警告

manifest 不合规不会让 CLI 崩溃，只会产生**结构化警告**（`--json` 下在包络 `warnings` 数组里，human 模式下在 stderr）：

| 警告码 | 场景 |
|---|---|
| `E_PLUGIN_LOAD_FAILED` | index.mjs 缺失或有语法错误 |
| `E_PLUGIN_MANIFEST_INVALID` | manifest 字段不合规（错误清单会附在 message 里） |
| `E_PLUGIN_DUPLICATE` | 同名插件重复发现（低优先级来源被跳过） |
| `E_PLUGIN_COMMAND_CONFLICT` | 插件命令与已有命令重名（该命令被跳过） |

校验失败的具体字段路径（如 `commands[0].handler 必须是函数`）会随警告 message 输出，按提示修正即可。

## 完整示例

见仓库 `plugins/hello/index.mjs`——它同时是业务功能接入的最小模板：复制目录、改 `name` 与命令定义，即可接入你的第一个业务功能。
