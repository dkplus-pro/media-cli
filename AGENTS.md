# AGENTS.md — common-cli 架构约束（人与 AI 协作者必读）

本文件是**硬约束**。任何改动（无论人还是 agent）提交前必须逐条对照文末「变更检查清单」。
方案全文见 `docs/plans/00-master-plan.md`，各阶段执行细节见 `docs/plans/01`–`05`。

## 1. 项目定位

通用 Node CLI 壳（包名 `common-cli`，命令名 `common-cli`），同时服务人类用户与 AI agent。
**本仓库不含具体业务功能**；业务能力一律以插件形式接入（见 §5 插件契约）。

## 2. 技术底座（不可擅自更改）

| 项 | 决策 |
|---|---|
| 语言/构建 | TypeScript（strict）+ tsup，产物纯 ESM |
| 运行环境 | Node >= 20（`engines` 字段声明） |
| 包管理器 | pnpm |
| CLI 框架 | commander |
| 质量/测试 | Biome（lint + format）、Vitest（单测 + e2e spawn）、simple-git-hooks + lint-staged |

更改以上任何一项属于架构变更：必须先更新本文件与 `docs/plans/00-master-plan.md` 并说明理由，再动代码。

## 3. 目录分层（依赖只允许自上而下）

```
src/bin/        唯一入口：shebang + 调用 cli/main，不含任何逻辑
src/cli/        装配层：program 构建、全局选项预扫描、插件装载编排、执行与退出码收敛
src/commands/   内置命令（version、spec）与命令注册器 registry
src/plugins/    插件发现（discover）、manifest 校验（manifest）、动态加载（loader）
src/core/       错误模型 errors、退出码 exit-codes、输出契约 output/*、运行上下文 context、共享类型 types
tests/          unit/（直接 import src）+ e2e/（spawn dist 真进程）+ fixtures/
```

依赖方向：`bin → cli → {commands, plugins} → core`。
**禁止**：反向依赖；跨层依赖（如 `commands` 直接 import `cli`）；`core` import 任何其他 `src` 层；
业务代码散落在 `core`（core 只做壳机制，不做业务）。

## 4. 输出契约不变量（最高优先级，破坏即 bug）

1. **stdout 只写命令数据，stderr 只写日志/警告**。全仓库只允许 `src/core/output/` 触碰 `process.stdout/stderr`（测试除外）。
2. `--json` 模式下 stdout 有且只有一个 JSON 文档：
   - 成功：`{ "ok": true, "data": <命令数据>, "warnings": Warning[] }`
   - 失败：`{ "ok": false, "error": { "code": string, "message": string, "details"?: unknown }, "warnings": Warning[] }`
3. 错误码 `E_*` 大写下划线命名，登记在 `src/core/errors.ts`；**一经发布不可改名/删除，只可新增**。
4. 退出码表不可改（只可新增）：`0` 成功；`1` 未捕获/内部错误；`2` 用法类错误（E_USAGE / E_COMMAND_NOT_FOUND / E_MISSING_ARGUMENT / E_INVALID_OPTION）；`3` 命令执行错误；`4` 保留（未来插件致命错误）。
5. 命令与插件 handler **只能 return 数据或 throw CliError**，不得直接写流、不得调用 `process.exit`。
6. **非交互**：壳与插件不得调用任何交互式 prompt；必填输入缺失时 throw `E_MISSING_ARGUMENT`。保证管道/CI/AI 调用永不挂起。
7. human 模式下错误与警告输出到 stderr，格式 `[级别] [CODE] message`。

## 5. 插件契约

- 位置与优先级：环境变量 `COMMON_CLI_PLUGINS_DIR`（`:` 分隔，测试用）> 项目 `./plugins/` > 全局 `~/.common-cli/plugins/`；同名插件按此顺序先到先得，后者跳过并警告。
- 形态：每个插件一个目录，入口 `index.mjs`（ESM），默认导出声明式 manifest：
  `{ name, version, commands: [{ name, description, options?, handler }] }`。
- 校验：手写校验（`src/plugins/manifest.ts`），不引入第三方 schema 库。
- 容错：**单插件失败 → 结构化警告并继续**；插件命令与已有命令重名 → 警告并跳过该命令；插件不得绕过声明式接口直接获取 commander `program` 实例。
- handler 只 return 数据或 throw CliError，输出一律由壳写入（同 §4.5）。

## 6. 代码规范

- **单文件超过 300 行必须拆分**：拆成「主入口 + 模块」；主入口只做组织与再导出。
- 新命令必须走 `src/commands/registry.ts` 的声明式定义（含内置命令），禁止绕过注册器手工 `addCommand`。
- 新错误码必须同步登记 `src/core/errors.ts` 并更新 `docs/plans/00-master-plan.md` 的错误码表。
- `pnpm lint && pnpm build && pnpm test` 全绿才算完成；e2e 测试必须 spawn `dist` 真进程验证契约。
- 提交信息格式：`phase-NN: 摘要`（架构/文档类用 `docs:`/`chore:` 前缀）。

## 7. 多 agent 执行协议

- **planner**：把阶段文档拆解为可执行任务（文件清单 + 实现要点 + 禁止事项），分配给 coding-agent。
- **coding-agent × 2**：并行执行文件集不相交且接口已由阶段文档锁定的任务。
- **test-agent**：执行阶段验收命令并回报结果。
- 阶段严格串行（01→05），阶段内并行；每阶段验收通过后 commit 再进入下一阶段。

## 8. 变更检查清单（改代码前逐项自查）

- [ ] 是否破坏 stdout/stderr 分离或新增 stdout 写入点（绕过 `core/output`）？
- [ ] 是否改动错误码/退出码表？（只许新增，不许改名删除）
- [ ] 分层依赖是否合规（上层→下层，无反向/跨层）？
- [ ] 是否有文件超过 300 行未拆分？
- [ ] 新命令是否走声明式注册器？新错误码是否已登记？
- [ ] 是否存在任何交互式 prompt 调用？
- [ ] 新功能是否有对应测试（unit 或 e2e）？
- [ ] 文档是否需要同步（`AGENTS.md` / `docs/plans/00-master-plan.md` / `docs/plugin-development.md` / `README.md`）？
