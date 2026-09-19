# 阶段 05 — 测试与收尾（testing & hardening）

> 前置依赖：阶段 04。目标：测试矩阵补全、`AGENTS.md` 逐条合规校验、可选 CI。完成后项目达到 `00-master-plan.md` §8 全局 DoD。

## 任务清单

### T1 单元测试补全（`tests/unit/`）

- `errors.test.ts`：`exitCodeForError` 全分支（用法类→2、其他 CliError→3、非 CliError→1）；CliError 携带 code/details
- `writer.test.ts`：`--json` 成功/失败包络形状、warnings 注入；human 模式数据→stdout、错误→stderr（用可注入流或 mock `process.stdout/stderr`）
- `logger.test.ts`：quiet/verbose/json 三开关下各级日志的输出矩阵
- `manifest.test.ts`（03 已建）：补全校验规则边界（非法 name、缺 handler、options 非法项）
- `registry.test.ts`：重名注册返回 `{ok:false, warning}`；`list()` 含 source

### T2 e2e 测试补全（`tests/e2e/`，全部 spawn dist 真进程）

- `contracts.e2e.test.ts`（02 已建）：补 `--quiet`、`--verbose`、`NO_COLOR=1` 行为；stdout 严格可 `JSON.parse`
- `plugins.e2e.test.ts`（03 已建）：确认覆盖容错三路径
- `spec.e2e.test.ts`（04 已建）：schema 完整性
- 新增 `exit-codes.e2e.test.ts`：0/1/2/3 各至少一例（3 可由临时坏插件 handler 抛 CliError 构造：fixture `thrower`，`COMMON_CLI_PLUGINS_DIR` 注入）

### T3 `AGENTS.md` 合规校验（对照 §8 检查清单逐条）

逐条核查并记录证据；发现问题（如超 300 行文件、绕过注册器的命令、缺失测试）**直接修复**：

- [ ] stdout/stderr 分离：全仓库仅 `core/output` 触碰流（grep `process.stdout|process.stderr` 验证）
- [ ] 错误码/退出码与 master-plan §4.4/4.5 一致
- [ ] 分层：无反向/跨层 import（grep `from "../cli` in commands、`from "../commands` in core 等）
- [ ] 无 >300 行文件（`find src -name "*.ts" | xargs wc -l`）
- [ ] 所有命令走 registry；错误码在 errors.ts 有登记
- [ ] 无交互 prompt 依赖（package.json 无 inquirer/prompts 等）
- [ ] 每个功能有对应测试

### T4 CI（可选但建议）`.github/workflows/ci.yml`

- push/PR 触发；matrix node 20 + 22；步骤：checkout → pnpm setup → `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm build` → `pnpm test`

### T5 文档同步

- `README.md` 与实现一致（命令示例、验收命令）
- master-plan §2 决策表无漂移；若实现中做过偏离决策的调整，回写决策表

## Agent 分工

- **coding-agent A**：T1 + T2（测试补全与新增 fixture `thrower`）
- **coding-agent B**：T3 合规校验与修复 + T4 CI + T5 文档同步

## 验收标准（test-agent 执行）

```bash
pnpm install --frozen-lockfile && pnpm lint && pnpm build && pnpm test   # 全绿
find src -name "*.ts" -exec wc -l {} +          # 无文件超 300 行
grep -rn "process.stdout\|process.stderr" src/  # 仅 core/output 命中
node dist/common-cli.js --json spec && node dist/common-cli.js --json hello --name final
git log --oneline                                # 阶段提交历史完整
```
