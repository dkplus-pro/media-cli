# 阶段 01 — 壳补强与清理（shell hardening & cleanup）

> 前置依赖：无（壳阶段 01–05 已完成）。目标：为 media 插件提供**带语义错误码的抛错通道**（D7）；清理根目录残留拷贝、腾出 `./plugins/` 容器目录；补齐文档已引用但缺失的 `hello` 示例插件。

## 范围

做：3 个新错误码登记、registry 鸭子类型抛错识别、根目录残留删除、`plugins/hello/` 示例、壳侧文档同步。
不做：任何 media 业务命令（02–04）；不改壳的发现/校验/加载逻辑；不动 `AGENTS.md`。

## 任务清单

### T1 `src/core/errors.ts` — 错误码登记（只增不改）

- `CliErrorCode` 联合类型追加 `"E_CONFIG" | "E_MISSING_DEPENDENCY" | "E_PROVIDER_ERROR"`。
- `CLI_ERROR_CODES` 常量同步追加三项（顺序追加到末尾，不动已有项）。
- 退出码不新增：三码均非用法类，`exitCodeForError` 现有逻辑自动落 exit 3，无需改动。
- 禁止：改动/删除任何既有错误码；引入第三方 schema 库。

### T2 `src/commands/registry.ts` — 鸭子类型抛错识别（D7）

`attachTo` 的 catch 分支（当前第 49–59 行）改为三档：

```ts
catch (err) {
  const e = err instanceof CliError
    ? err
    : asCodedError(err) ?? new CliError("E_INTERNAL", msg(err));
  ...
}
```

- 新增模块级 `asCodedError(err)`：`err` 为对象且 `typeof err.code === "string"`、`err.code` 命中 `CLI_ERROR_CODES` 登记表 → 构造 `CliError(err.code, err.message ?? String(err), err.details)`；未命中/非对象 → `undefined`。
- 校验码必须**已登记**（防插件拼错码绕过错误码表）。
- 行为不变性：现有 unit/e2e（thrower fixture → E_INTERNAL → exit 3）必须保持全绿。

### T3 测试 — 新抛错通道

- `tests/unit/errors.test.ts`：追加三码断言（均 exit 3）；`asCodedError` 直接单测（带码对象 / 未登记码 / 普通对象 / null）。
- `tests/unit/registry.test.ts`：追加「handler throw `{code:"E_CONFIG"}` → 包络 error.code === "E_CONFIG"、exit 3」分支。
- 新 fixture `tests/fixtures/plugins/coded-thrower/index.mjs`：命令 `coded-throw`，handler `throw Object.assign(new Error("bad config"), { code: "E_CONFIG", details: { var: "SUNO_API_KEY" } })`。
- `tests/e2e/contracts.e2e.test.ts`：用 `COMMON_CLI_PLUGINS_DIR` 挂载 coded-thrower，断言 `--json` 包络 `error.code === "E_CONFIG"`、`error.details.var`、退出码 3、human 模式 stderr 出现 `[error] [E_CONFIG]`。

### T4 根目录残留清理（删除操作，执行前必须复核）

以下文件是 `src/` 同名文件的**逐字节重复拷贝**（重构残留，被 git 追踪但不被 `tsconfig.json`/`tsup.config.ts` 引用）。`git rm` 前先逐项 `diff` 复核确认为重复：

```
bin/common-cli.ts
cli/main.ts  cli/options.ts  cli/program.ts
commands/registry.ts  commands/builtin/spec.ts  commands/builtin/version.ts
core/context.ts  core/errors.ts  core/exit-codes.ts  core/types.ts
core/output/logger.ts  core/output/warnings.ts  core/output/writer.ts
plugins/discover.ts  plugins/loader.ts  plugins/manifest.ts  plugins/types.ts
errors.ts  context.ts  exit-codes.ts  types.ts
```

复核命令（应零输出）：`for f in bin cli commands core plugins errors.ts context.ts exit-codes.ts types.ts; do diff -rq "$f" "src/$f" 2>/dev/null; done`
注意：根级 `plugins/` 目录同样是残留 TS 拷贝（**不是**插件容器），一并删除——腾出 `./plugins/` 容器目录位置（发现器把它当容器目录扫描）。删除后 `pnpm build && pnpm test` 必须全绿，证明它们确实不被构建引用。

### T5 `plugins/hello/index.mjs` — 示例插件与容器目录

- 按 `docs/plans/04-introspection-and-example.md` T2 模板原样创建（name `hello`，命令 `hello --name`）。
- 从仓库根运行即可自动加载（容器目录 `./plugins/`）。
- 检查 `tests/e2e/spec.e2e.test.ts`：若存在命令集**严格断言**（不含 hello 会挂），同步把 hello 加入期望集。

### T6 文档同步（AGENTS.md §6 要求，动 errors 必同步文档）

- `docs/plans/00-master-plan.md` §4.4 错误码表追加三行（`E_CONFIG` / `E_MISSING_DEPENDENCY` / `E_PROVIDER_ERROR`，退出码均 3）。
- `docs/plugin-development.md` handler 契约更正：插件**无法 import 壳的 CliError**（包未发布），抛错改为 `throw Object.assign(new Error(msg), { code, details })` 并附示例；同步更新 hello 相关引用与警告码表说明。
- `README.md`：确认 `hello` 示例命令可跑通（本阶段后即真）。

## 执行方式（planner 编排 + 主 agent 执行）

planner 将 T1→T6 排序派发（T1/T2/T3 强耦合先做，T4 独立做且删除前复核，T5/T6 收尾）；主 agent 串行执行；禁止事项：T4 未经 diff 复核不得删除；T1 只增不删；全程不触碰 `AGENTS.md`。完成后跑验收块，commit `media-01: shell hardening and cleanup`。

## 验收标准（主 agent 执行并回报证据）

```bash
pnpm lint && pnpm build && pnpm test                  # 全绿
node dist/common-cli.js --json version                # 退出 0
node dist/common-cli.js --json hello --name AI        # data.message === "hello, AI!"（容器目录插件自动加载）
node dist/common-cli.js --json hello                  # data.message === "hello, world!"
node dist/common-cli.js --json coded-throw            # exit 3；error.code === "E_CONFIG"；details.var === "SUNO_API_KEY"
git ls-files | grep -E "^(bin|cli|commands|core|output|plugins)/.*\.ts$"   # 零输出（残留已清；根级 output/ 若存在同删）
grep -c "E_CONFIG\|E_MISSING_DEPENDENCY\|E_PROVIDER_ERROR" src/core/errors.ts  # ≥ 3
```
