# media-cli 总体方案（Master Plan）

> 日期：2026-09-20。本文档是项目的**方案记录与唯一事实源**：所有架构决策在此登记，阶段执行细节见同目录 `01`–`05` 阶段文档。架构硬约束的精简版在仓库根 `AGENTS.md`。

## 1. 背景与定位

构建一个**通用 Node CLI 壳**：不包含具体业务功能，但为未来业务功能提供简单、规范的接入方式。核心设计目标：**给人用，也给 AI 用**——人类得到友好的帮助文本与彩色输出，AI 得到可机器解析的稳定 JSON 契约与自省能力。

## 2. 决策记录（design decisions）

以下决策经评审锁定，变更需先改本表并同步 `AGENTS.md`。

| # | 分支 | 决策 | 理由 |
|---|---|---|---|
| D1 | 语言/构建 | TypeScript + tsup，开发期 tsx 直跑 | 类型安全；tsup 零配置打包 ESM；AI 生态最熟悉 |
| D2 | 模块格式 | 纯 ESM（`"type": "module"`） | Node >= 20 支持完善，构建与代码最简 |
| D3 | 包管理器 | pnpm | 快、磁盘省、lockfile 严格 |
| D4 | CLI 框架 | commander | 生态最成熟，帮助信息自动生成，API 直觉 |
| D5 | 业务接入 | **插件动态加载**（本地目录发现） | 免发布即可迭代；版本/安装问题后续再演进 |
| D6 | 插件形态 | 声明式导出 manifest（含 handler），壳全权控制注册 | 输出契约可强制落地，插件无法绕过 |
| D7 | 插件容错 | 单插件失败 → 结构化警告并继续 | 一个坏插件不能瘫痪整个 CLI |
| D8 | AI 契约 | 全量：每命令 `--json`；stdout=数据 / stderr=日志；稳定错误码；退出码成文 | AI 可可靠解析一切输出 |
| D9 | 自省能力 | `spec` 命令输出完整命令树 JSON schema | AI 无需读文档即可自发现全部能力 |
| D10 | 交互策略 | 非交互优先：壳永不 prompt，缺参结构化报错 | AI/脚本调用永不挂起 |
| D11 | 文档结构 | 总纲 + 编号阶段文件（本目录） | 执行 agent 只需读自己阶段的文档 |
| D12 | 架构约束 | `AGENTS.md` 硬约束 + 变更检查清单；单文件 > 300 行拆分 | 约束 agent 后续改动仍守架构 |
| D13 | 质量工具 | Biome、Vitest、simple-git-hooks + lint-staged | 依赖少、速度快 |
| D14 | 执行编排 | 阶段串行 + 阶段内并行（planner 编排，2 个 coding-agent 执行） | 依赖清晰，冲突最少 |
| D15 | 命名（2026-09-26） | 命令名随发布物更名：`common-cli` → `media-cli`（bin、入口 `src/bin/media-cli.ts`、env `MEDIA_CLI_PLUGINS_DIR`、全局目录 `~/.media-cli/` 同步更名）。v0.1.0 尚未发布，无兼容负担，不做旧名兼容 | 命令名此前为通用壳名 `common-cli`，与 npm 包名 `@dkplus/media-cli` 割裂，用户与 AI 调用时易混淆；首个发布物即 media 插件集，壳名跟随产品，业务区分仍由命令前缀（D8）承担。历史阶段文档（01–05）保留旧名作为当时记录，不回改 |

## 3. 架构总览

```
                    argv
                     │
  ┌──────────────────▼───────────────────┐
  │ src/bin/media-cli.ts (唯一入口)       │
  └──────────────────┬───────────────────┘
  ┌──────────────────▼───────────────────┐
  │ src/cli/  装配层                      │
  │  main.ts     run() 总编排            │
  │  program.ts  commander 构建+错误映射  │
  │  options.ts  全局选项预扫描           │
  └───────┬──────────────────┬───────────┘
          │                  │
  ┌───────▼────────┐  ┌──────▼─────────────┐
  │ src/commands/  │  │ src/plugins/       │
  │  registry.ts   │◄─│  discover.ts       │
  │  builtin/      │  │  manifest.ts       │
  │    version.ts  │  │  loader.ts         │
  │    spec.ts     │  │  types.ts          │
  └───────┬────────┘  └──────┬─────────────┘
          │                  │
  ┌───────▼──────────────────▼─────────────┐
  │ src/core/  机制层（不含业务）           │
  │  errors.ts  exit-codes.ts  types.ts    │
  │  context.ts  output/{writer,logger,warnings}.ts │
  └────────────────────────────────────────┘
```

`run(argv)` 总流程：构建 program → 预扫描全局选项（使加载期日志遵守模式）→ 注册内置命令 → 发现并加载插件（收集警告）→ 注册插件命令 → `parseAsync` → 执行命令 handler（return 数据）→ 按模式写输出 → 收敛退出码。

## 4. 输出契约规范（人/AI 双契约）

### 4.1 全局选项

`--json`（机器模式）· `--quiet`（抑制 info 日志）· `--verbose`（debug 日志）· `--no-color`（同时尊重 `NO_COLOR` 环境变量）· `--version` · `--help`。
解析采用两段式：加载插件前对 argv 做全局选项**预扫描**，parse 后以 commander 结果为准。

### 4.2 流分离

| 流 | human 模式 | `--json` 模式 |
|---|---|---|
| stdout | 命令数据（文本） | **有且只有一个** JSON 文档 |
| stderr | 日志/警告（`[级别] [CODE] message`） | 默认静默；`--verbose` 才输出 debug 日志 |

`--json` 模式下 stdout 必须能被 `JSON.parse` 直接解析（e2e 保证）。

### 4.3 JSON 包络

```jsonc
// 成功
{ "ok": true,  "data": <命令返回值>, "warnings": Warning[] }
// 失败（仍输出到 stdout，退出码非 0）
{ "ok": false, "error": { "code": "E_...", "message": "...", "details": {} }, "warnings": Warning[] }
// Warning: { "code": string, "message": string, "plugin"?: string }
```

### 4.4 错误码表（初始，只可新增）

| 错误码 | 含义 | 退出码 | 出现方式 |
|---|---|---|---|
| E_USAGE | 用法错误（未知选项/参数值非法） | 2 | error |
| E_COMMAND_NOT_FOUND | 未知命令 | 2 | error |
| E_MISSING_ARGUMENT | 缺少必需输入 | 2 | error |
| E_INVALID_OPTION | 选项值/参数值非法（校验用，预留给命令级校验） | 2 | error |
| E_INTERNAL | 未预期内部错误 | 1 | error |
| E_PLUGIN_MANIFEST_INVALID | 插件 manifest 校验失败 | 0 | warning |
| E_PLUGIN_LOAD_FAILED | 插件导入/执行失败 | 0 | warning |
| E_PLUGIN_COMMAND_CONFLICT | 插件命令与已有命令重名 | 0 | warning（跳过该命令） |
| E_PLUGIN_DUPLICATE | 同名插件重复发现 | 0 | warning（跳过低优先级插件） |
| E_CONFIG | 配置缺失/非法（key 无效、池长度不等、whisper 模型缺失） | 3 | error |
| E_MISSING_DEPENDENCY | 外部二进制缺失（ffmpeg/ffprobe/whisper.cpp，details 带安装提示） | 3 | error |
| E_PROVIDER_ERROR | 外部提供方执行失败（远端 API 非 2xx、本地进程失败） | 3 | error |

### 4.5 退出码表（不可改，只可新增）

`0` 成功 · `1` 未捕获/内部错误 · `2` 用法类错误 · `3` 命令执行错误（handler 抛出）· `4` 保留（未来插件致命错误）。

### 4.6 非交互保证

壳与插件一律不调用交互式 prompt。必填输入缺失 → throw `E_MISSING_ARGUMENT`（exit 2）。管道/CI/AI 调用永不挂起。

## 5. 插件契约规范

### 5.1 发现顺序（先到先得）

1. `MEDIA_CLI_PLUGINS_DIR`（`:` 分隔，测试与高级用法）
2. 项目 `./plugins/`（仅当存在）
3. 全局 `~/.media-cli/plugins/`
4. 随包内置 `<包根>/plugins/`（npm 发布用；按 CLI 模块位置向上找 package.json 定位包根；与项目目录相同时跳过）

语义：`MEDIA_CLI_PLUGINS_DIR` 的每一项即**单个插件目录**（入口 `index.mjs`）；项目与全局路径是**容器目录**，其一级子目录为插件目录。

同名插件（manifest.name 重复）：高优先级来源胜出，低优先级跳过并警告 `E_PLUGIN_DUPLICATE`。

### 5.2 manifest 结构（声明式）

每个插件 = 一个目录，入口 `index.mjs`（ESM），默认导出：

```js
export default {
  name: "hello",            // 必填，^[a-z][a-z0-9-]*$
  version: "0.1.0",         // 必填，字符串
  commands: [               // 必填，可为空数组
    {
      name: "hello",        // 必填，扁平命名空间，全局唯一
      description: "Greet", // 必填
      options: [ { flags: "--name <name>", description: "Who" } ], // 可选
      handler: (ctx, args) => ({ message: `hello, ${args.name ?? "world"}` })
      // handler 只 return 数据或 throw CliError；输出由壳写入
    }
  ]
}
```

### 5.3 校验与容错

`src/plugins/manifest.ts` 手写校验（不引第三方 schema 库），返回结构化错误列表。
任何加载/校验失败：记录 warning（见 4.4 表），**继续加载其余插件与内置命令**。命令重名：跳过该命令并警告 `E_PLUGIN_COMMAND_CONFLICT`。

## 6. 阶段索引（串行 01→05）

| 阶段 | 文档 | 目标 | 依赖 |
|---|---|---|---|
| 01 | `01-repo-foundation.md` | 仓库底座：构建/质量工具/bin 最小可跑 | 无 |
| 02 | `02-core-shell-and-contracts.md` | 核心骨架与双契约：core/cli/commands、version、错误与退出码 | 01 |
| 03 | `03-plugin-system.md` | 插件系统：发现/校验/加载/挂载/容错 | 02 |
| 04 | `04-introspection-and-example.md` | 自省与示例：spec 命令、hello 插件、开发指南 | 03 |
| 05 | `05-testing-and-hardening.md` | 测试补全、AGENTS.md 合规校验、CI | 04 |

## 7. 执行协议（多 agent 协作）

1. **planner**：读取阶段文档，拆解为任务清单（文件 + 要点 + 禁止事项），分配给 coding-agent（文件集不相交才可并行）。
2. **coding-agent / coding-agent-2**：按分配实现；不得越界改他人文件；遵守 `AGENTS.md`。
3. **test-agent**：执行阶段验收命令，回报通过/失败证据。
4. 主控审查 → `git commit`（`phase-NN: 摘要`）→ 进入下一阶段。全部完成后统一 push。

## 8. 全局验收标准（Definition of Done）

- [ ] `pnpm install && pnpm lint && pnpm build && pnpm test` 全绿（Node >= 20）
- [ ] `node dist/media-cli.js --version` / `version` / `spec` / `hello` 输出符合本契约
- [ ] e2e 覆盖：双模式输出、JSON 包络可解析、错误码与退出码、插件容错（坏插件只警告）
- [ ] `AGENTS.md` 每条约束都有对应实现与测试
- [ ] git 历史按阶段清晰提交，最终 push 到 `origin/main`
