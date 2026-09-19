# 阶段 05 — npm 发布准备（@dkplus/media-cli）

> 前置依赖：阶段 01–04。目标：CLI 可通过 npm 全局安装并**自带全部 media 插件**——包名 `@dkplus/media-cli`（D13）。用户在任意目录运行即可用全部命令。

## 范围

做：新增「随包内置」（bundled）插件发现源（**架构变更**，同步 AGENTS.md §5 与壳 `docs/plans/00-master-plan.md` §5.1——本阶段经用户确认解除媒体阶段 D6「AGENTS.md 不动」的限制，仅此一处）；`package.json` 发布元数据与 `LICENSE`；模拟安装布局的 e2e。
不做：CI 自动发布；`npm publish` 本身（需用户 `npm login` 后执行，见文末发布步骤）。

## 核心问题与方案

现状：插件只从 `COMMON_CLI_PLUGINS_DIR`、`<cwd>/plugins/`、`~/.common-cli/plugins/` 三处发现，且 `files: ["dist"]` 不含 `plugins/`——npm 安装后在任意目录运行只会得到空壳。

方案（D13）：
1. 新增第四个发现源 **bundled**：按 CLI 自身安装位置（`import.meta.url`）解析 `<包根>/plugins/`，随包分发、随装随用。
2. 优先级 **env > project > global > bundled**（内置版最低）：用户可用项目或全局同名插件**覆盖**内置版本（先到先得规则复用）。
3. 开发态（仓库内）bundled 解析结果与 project 目录相同 → 路径相等时跳过 bundled 扫描，避免 `E_PLUGIN_DUPLICATE` 噪音警告。

## 任务清单

### T1 `src/plugins/types.ts` + `src/plugins/discover.ts` — bundled 发现源

- `PluginSource` 追加 `"bundled"`。
- `discoverPluginDirs` 追加第四段：`bundledDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugins")`（tsup 单文件 bundle 落在 `<包根>/dist/common-cli.js`，故 `../../plugins` 即包根 plugins；tsx 直跑 `src/bin/` 时同样回到仓库根 plugins）。扫描结果 source 记为 `"bundled"`，追加在 global 之后（最低优先级）。
- 当 `resolve(bundledDir) === resolve(join(cwd, "plugins"))` 时跳过（开发态同一目录）。
- tsup 单文件 bundle 会内联本模块，`import.meta.url` 语义在 esm 输出下保留，需 build 后验证。

### T2 测试

- 单测 `tests/unit/discover.test.ts`（新建）：注入临时目录与 env，覆盖 env 优先、容器扫描、bundled 与 project 同目录跳过、四源顺序。
- e2e `tests/e2e/bundled-plugins.e2e.test.ts`（新建）：模拟安装布局——把 `dist/common-cli.js` 拷到 `<tmp>/pkg/dist/`，在 `<tmp>/pkg/plugins/` 放一个 `demo` 插件，从 `<tmp>`（非仓库根）spawn，断言 bundled 命令可用且 `spec` 中 source 为 `plugin:demo`；再断言仓库根运行时 warnings 无 `E_PLUGIN_DUPLICATE`（同目录去重生效）。

### T3 `package.json` + `LICENSE` — 发布元数据

- `name: "@dkplus/media-cli"`；删除 `private`；`publishConfig: { "access": "public" }`。
- `version: 0.1.0`；`license: "MIT"` + 根目录新增 `LICENSE`（MIT，Copyright (c) 2026 dkplus-pro）。
- `description` / `keywords` / `repository`（github.com/dkplus-pro/media-cli）。
- `files: ["dist", "plugins"]`——README/LICENSE 由 npm 自动带上。
- bin 保持 `common-cli`（全局安装后的命令名不变）。

### T4 文档同步（架构变更强制）

- `AGENTS.md` §5 位置优先级行追加「> 随包内置（包内 `plugins/`，npm 发布用）」。
- 壳 `docs/plans/00-master-plan.md` §5.1 同步发现顺序。
- media `docs/plans/media/00-master-plan.md` 决策表追加 D13、阶段索引追加 05。
- `README.md`：新增「安装」小节（`npm i -g @dkplus/media-cli`）与内置插件说明。
- `docs/plugin-development.md` 本地调试小节的位置列表同步。

## 执行方式（planner 编排 + 主 agent 执行）

T1→T2→T3→T4 串行；T1 是壳改动（core/plugins 层），禁止触碰输出契约与错误码表。验收全绿后 commit `media-05: npm publish prep with bundled plugin source`。

## 验收标准（主 agent 执行并回报证据）

```bash
pnpm lint && pnpm build && pnpm test                  # 全绿
npm pack --dry-run                                    # 包内含 dist/ 与 plugins/（四个插件）、package.json、README、LICENSE
node dist/common-cli.js --json spec                   # 12 命令齐全且 warnings 无 E_PLUGIN_DUPLICATE
# 模拟安装布局 e2e 由 tests/e2e/bundled-plugins.e2e.test.ts 覆盖

# 发布（用户登录后执行）：
npm login          # 需要 npm 账号（scope 为 dkplus）
npm publish        # publishConfig.access=public 已配置，无需额外参数
```
