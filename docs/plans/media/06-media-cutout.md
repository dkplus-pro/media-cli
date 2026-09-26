# 阶段 06 — media-cutout 插件（本地抠图，macOS Vision）

> 前置依赖：阶段 01–05。目标：本地抠图命令——去背景产透明 PNG，默认裁剪到主体包围盒并留边距；输入单文件或文件夹。引擎用 macOS Vision framework（用户确认，D14）。

## 范围

做：新插件 `media-cutout`（命令 `media-cutout`）、Swift 单文件工具源码 + 运行时编译缓存、文件夹批处理、e2e。
不做：非 macOS 回退引擎（rembg 等，留待演进）；视频抠图；多主体分别导出；自动模型选择（Vision 系统内置，不可选）。

## 决策（grill-me 2026-09-20 确认）

| # | 决策 | 理由 |
|---|---|---|
| D14 | 引擎 = macOS Vision（`VNGenerateForegroundInstanceMaskRequest`，macOS 14+）。Swift 单文件工具随插件分发，**首次运行用 swiftc 编译**到 `~/.media-cli/cache/media-cutout/`（缓存名含源码 sha256 前 8 位，源码变更自动重编译）；`CUTOUT_BIN` env 可直接指定现成二进制跳过编译；非 macOS / 无 swiftc / 编译失败 → `E_MISSING_DEPENDENCY`（details 带平台说明与 `xcode-select --install` 提示） | ANE 加速单张 0.1–0.3s（rembg CPU 1–3s）；零模型下载；bbox 裁剪在 Swift 内一步完成；用户明确选择 |
| D15 | 默认**裁剪到主体包围盒** + `--padding <px>`（默认 32，clamp 至不越画布）；`--no-crop` 保留原始画布尺寸只去背景 | 用户原话「仅保留主体，主体周围留一点边距」 |
| D16 | 文件夹输入：**一级遍历 + `--recursive` 递归**（递归时输出按相对路径 mirror）；`--output` 为目录（缺省 `./cutout`）；扩展名白名单 `jpg/jpeg/png/webp`；单张失败 → 记入 `data.failed` 继续其余 | 可控性优先；与壳「单插件失败警告继续」精神一致 |
| D17 | 命令归属：新插件 `media-cutout`，命令 `media-cutout` | media-* 前缀=本地系；不沾 ffmpeg 系 media-av |

## 命令契约

**`media-cutout`** — 抠图（单文件或文件夹 → 透明 PNG）

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <path>` | 必填 | 图片文件或文件夹（文件夹按 D16 遍历） |
| `--output <path>` | 单文件: `<input>-cutout.png`；文件夹: `./cutout/` | 输出文件/目录 |
| `--padding <px>` | 32 | 主体包围盒外边距（仅裁剪模式） |
| `--no-crop` | — | 保留原始画布尺寸，只去背景 |

data（单文件）：`{ "path": string, "width": number, "height": number, "cropped": boolean, "padding": number }`
data（文件夹）：`{ "outputDir": string, "results": [同上], "failed": [{ "file": string, "reason": string }], "total": number }`——部分失败仍 exit 0（全失败 → `E_PROVIDER_ERROR`）。

错误映射：找不到主体 → `E_PROVIDER_ERROR`（`details.reason: "no_subject"`，单张场景直接失败）；Vision/编译进程失败 → `E_PROVIDER_ERROR`（`details.source: "vision"/"swiftc"`）；其余复用既有码，**不新增错误码**。

## Swift 工具（`plugins/media-cutout/swift/vision-cutout.swift`）

用法 `vision-cutout <input> <output> <padding|-1>`（-1 表示不裁剪）：
1. `CIImage(contentsOf:)` 读入 → `VNImageRequestHandler` + `VNGenerateForegroundInstanceMaskRequest`。
2. `observation.mask(ofInstances: allInstances, ...)` → `CIBlendWithMask` 合成透明背景（background = clear cropped to extent）。
3. 渲染 CGImage 后扫描 alpha 通道算包围盒 → insetBy(±padding) clamp 画布 → `cropping(to:)`（padding ≤ 0 或 -1 则整图输出）。
4. `NSBitmapImageRep` 写 PNG。非 0 退出码 + stderr `E:<message>` 由 Node 端映射为 `E_PROVIDER_ERROR`。
编译：`swiftc -O -target arm64-apple-macos14.0 <src> -o <tmp> && mv`（先写临时再 rename 保证原子）。

## 插件结构（纯 .mjs 零 npm 依赖）

```
plugins/media-cutout/
  index.mjs            # manifest
  lib/config.mjs       # CUTOUT_BIN/缓存路径/swiftc 探测与编译（版本哈希）
  lib/files.mjs        # 输入枚举：单文件/一级/递归 + 扩展名过滤
  lib/runner.mjs       # spawn Swift 工具 + stderr 映射
  swift/vision-cutout.swift
```

约定同既有插件：handler 只 return/throw 带码 Error；spawn 用 execFile 参数数组；`ctx.logger` 进度日志（stderr）。

## 任务清单

### T1 Swift 工具源码 `swift/vision-cutout.swift`
按上文规格实现；本机 `swiftc` 实测编译通过 + 对 fixture 图片（ffmpeg 生成黑底彩色圆）跑通：产物 PNG、尺寸 = bbox+padding、四角像素 alpha=0。

### T2 `lib/config.mjs` — 二进制解析与编译
- `CUTOUT_BIN` 有效 → 直接用；无效路径 → `E_MISSING_DEPENDENCY`。
- 缓存 `~/.media-cli/cache/media-cutout/vision-cutout-<hash8>`（hash = 源码 sha256 前 8 位）存在且可执行 → 用。
- 否则 PATH 找 `swiftc`（找不到 → `E_MISSING_DEPENDENCY`，hint：`xcode-select --install；仅支持 macOS 14+`）→ 编译到缓存（临时名 + rename）。
- 编译失败 → `E_PROVIDER_ERROR`（details.source "swiftc"，stderr 摘要）。

### T3 `lib/files.mjs` + `lib/runner.mjs` + `index.mjs`
- 枚举：文件直接返回；文件夹按 D16；白名单外忽略（递归时跳过隐藏目录与 node_modules）。
- 输出名：单文件 `<input>-cutout.png`（或 --output）；文件夹 `outputDir/<相对路径>.png`（按需 mkdir）。
- 每张 spawn 一次工具；stderr `E:*` → `E_PROVIDER_ERROR`；捕获单张失败进 failed。
- handler 校验顺序：`--input`（E_MISSING_ARGUMENT）→ padding 数字校验（E_INVALID_OPTION）→ 引擎解析（E_MISSING_DEPENDENCY）→ 枚举为空（E_INVALID_OPTION：无可处理图片）。

### T4 e2e `tests/e2e/media-cutout.e2e.test.ts`
- 无条件错误分支：缺 `--input` → E_MISSING_ARGUMENT；`CUTOUT_BIN=/nonexistent` → E_MISSING_DEPENDENCY；`--padding abc` → E_INVALID_OPTION。
- `skipIf(!darwin || 无 swiftc)` 集成分支（CI Linux 自动跳过）：fixture 用 ffmpeg geq 生成黑底实心圆 PNG；断言单文件成功、输出 PNG 存在、`cropped === true`、宽高 < 原图（bbox 生效）；`--no-crop` 时宽高 = 原图；文件夹批量含 1 张坏图（如 .txt 伪装）→ `failed` 记录且其余成功；`--recursive` 生成 mirror 子目录。
- **若 Vision 在合成图上判 no_subject**：调整 fixture（加渐变/纹理提高对比）后重测，仍不行则集成分支降级为「工具编译 + no_subject 报错路径」断言并在文档注明。

### T5 文档
- README 新增 media-cutout 小节（macOS 14+ 限制、首次运行编译说明、示例）；media master-plan 决策表补 D14–D17、阶段索引补 06。

## 执行方式（planner 编排 + 主 agent 执行）

T1→T5 串行；T1 编译与 fixture 效果先在 T1 阶段实测确认再往下走。commit `media-06: media-cutout plugin with macOS Vision subject lifting`。

## 验收标准（主 agent 执行并回报证据）

```bash
pnpm lint && pnpm build && pnpm test                  # 全绿（Linux CI 自动跳过集成分支）
node dist/media-cli.js --json media-cutout --input <fixture 圆图> --output /tmp/cut.png
#   exit 0；cropped===true；/tmp/cut.png 打开为透明底主体、带边距
node dist/media-cli.js --json media-cutout --input <fixture> --no-crop --output /tmp/cut2.png
#   宽高 = 原图
node dist/media-cli.js --json media-cutout --input <fixture 目录> --output /tmp/cutout
#   批处理 data.results + failed 语义正确
node dist/media-cli.js --json spec | grep media-cutout   # source 为 plugin:media-cutout
node dist/media-cli.js --json media-cutout               # exit 2；E_MISSING_ARGUMENT
```
