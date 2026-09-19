# media 媒体业务方案（Master Plan）

> 日期：2026-09-20。本文档是 media 业务能力的**方案记录与唯一事实源**。宿主是通用壳 `common-cli`（壳的方案见 `docs/plans/00-master-plan.md`，其阶段 01–05 已完成）：壳不含业务，media 能力全部以**项目级插件**接入。阶段执行细节见同目录 `01`–`04` 阶段文档。

## 1. 背景与定位

在通用壳上接入三类媒体能力，服务人类、AI agent 与 CI 管道三类调用方：

1. **简单转化**（本地 ffmpeg / whisper.cpp，零 API 费用）：
   - 视频转 4×4 胶片流图——一张 16 格拼图让 AI 一眼了解视频画面内容
   - 视频转音频
   - 音频转字幕，导出 SRT
2. **azure-image**：Azure OpenAI `gpt-image-2` 生图（纯文案生图 / 参考图+文案生图）
3. **suno 音乐**（open.suno.cn 中转 API）：文生音乐 / 文生音效

所有命令遵守壳的双契约：`--json` 单文档包络、stdout=数据 / stderr=日志、稳定错误码、非交互永不挂起。

## 2. 决策记录

以下决策经 2026-09-20 逐分支评审锁定（grill-me 记录），变更需先改本表。

| # | 分支 | 决策 | 理由 |
|---|---|---|---|
| D1 | 整体形态 | **3 个项目级插件**放 `./plugins/`：`media-av`、`azure-image`、`suno-music`；壳代码形态不动 | 符合 AGENTS.md「业务以插件接入」硬约束；能力互不拖累，可独立迭代 |
| D2 | ASR 引擎 | **本地 whisper.cpp**（外部二进制 + ggml 模型文件），与 ffmpeg 依赖风格一致 | 零 API 费用、离线可用、无 key 管理；缺失时报 `E_MISSING_DEPENDENCY` 并给安装提示 |
| D3 | suno 交互 | **默认阻塞轮询至完成并自动下载**到 `--output`；`--no-wait` 只提交返回 taskIds；另有 `suno-task` / `suno-download` / `suno-balance` 辅助命令 | AI/CI 一次调用拿结果；任务卡死/超时可用 download 恢复，不浪费已扣积分 |
| D4 | azure 池策略 | `KEY_POOL[i] ↔ ENDPOINT_POOL[i]` **按索引一一对应**（长度不一致 → `E_CONFIG`）；每次请求**随机**选账号发起，401/403/429/5xx/网络错误时**轮换下一个账号重试**（每账号至多 1 次），全池失败才报错 | 兼顾负载分散与故障转移 |
| D5 | 胶片图规格 | 时长**均匀采 16 帧**，每格缩放至 **320px 宽**（`--cell-width` 可覆盖），4×4 **JPG**，每格左下角烧录 `mm:ss` 时间戳；ffmpeg 无 drawtext 时降级为无时间戳 + 结构化警告 | 时间戳让 AI 能引用「00:42 处」；JPG 体积小适合喂模型 |
| D6 | 文档与协议 | 只新建 `docs/plans/media/`，**AGENTS.md 一字不动**；本方案执行协议（planner 编排 + 主 agent 执行）写本文 §8 | 壳的 00–05 文档与硬约束保持原样 |
| D7 | 插件抛错通道 | 壳登记新错误码 `E_CONFIG` / `E_MISSING_DEPENDENCY` / `E_PROVIDER_ERROR`（只新增）；`registry` catch 改为**鸭子类型识别**：抛出值带字符串 `code`（已登记码）即按该码处理，无需 import `CliError` | 插件是纯 `.mjs` 动态加载，实际无法 import 壳的 `CliError`（现状一律被包成 `E_INTERNAL`，语义全丢） |
| D8 | 命令命名 | 扁平命名空间 + 插件前缀：`media-*` / `image-*` / `suno-*` | 全局唯一，`spec` 输出可读性好；与 fixture `plugin-echo` 风格一致 |
| D9 | 输入参数 | 输入文件一律走 `--input <path>` 选项（registry 不支持位置参数）；缺失 → `E_MISSING_ARGUMENT`（exit 2） | 非交互契约；保持声明式注册器不改动 |
| D10 | 外部二进制 | env 可覆盖：`FFMPEG_PATH` / `FFPROBE_PATH` / `WHISPER_CPP_BIN` / `WHISPER_MODEL`；默认查 PATH；缺失/不可执行 → `E_MISSING_DEPENDENCY`，`details` 带安装提示 | 可测试（指向假路径即可触发错误分支）；对用户透明 |
| D11 | 远端 base URL | `SUNO_BASE_URL` 默认 `https://open.suno.cn`；azure 端点本身即 env。全部可指向 127.0.0.1 mock 服务器 | e2e 测试不依赖外网与真实 key |
| D12 | 提交格式 | media 阶段提交信息用 `media-NN: 摘要`（区别于壳的 `phase-NN`） | git 历史可区分壳与 media 两个建设期 |
| D13 | npm 发布 | 包名 `@dkplus/media-cli`；新增第四插件发现源「随包内置」（`<包根>/plugins/`，优先级最低：env > project > global > bundled），随包分发、随装随用 | npm 全局安装后在任意目录可用全部命令；用户可用同名插件覆盖内置版本（阶段 05） |

## 3. 命令契约

三插件共 9 个命令。所有命令：`--json` 成功返回 `data` 如下；失败抛带码错误（§5）；缺必填 → `E_MISSING_ARGUMENT`。

### 3.1 media-av（本地转化，依赖 ffmpeg/ffprobe/whisper.cpp）

**`media-filmstrip`** — 视频转 4×4 胶片流图

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <path>` | 必填 | 输入视频 |
| `--output <path>` | `<input>.filmstrip.jpg` | 输出图片 |
| `--cell-width <px>` | 320 | 单格宽度（clamp 160–640），整图宽 = 4×cell-width |
| `--format <jpg\|png>` | jpg | 输出格式 |

data：`{ "path": string, "width": number, "height": number, "cells": 16, "durationSec": number, "timestamps": boolean }`
实现：ffprobe 取时长 → `select` 按时间均匀采 16 帧 + `drawtext` 烧 `mm:ss` → `scale` → `tile=4x4` → 单帧输出。

**`media-to-audio`** — 视频转音频

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <path>` | 必填 | 输入视频/音频 |
| `--output <path>` | `<input>.mp3` | 输出音频 |
| `--format <mp3\|m4a\|wav\|flac\|ogg>` | mp3 | 容器/编码 |
| `--bitrate <rate>` | 192k | 仅有损格式生效 |

data：`{ "path": string, "format": string, "durationSec": number, "bytes": number }`

**`media-transcribe`** — 音频/视频转 SRT 字幕

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <path>` | 必填 | 输入音/视频（内部先经 ffmpeg 转 16k mono wav 临时文件） |
| `--output <path>` | `<input>.srt` | 输出字幕 |
| `--model-path <path>` | `WHISPER_MODEL` | ggml 模型路径；缺失 → `E_CONFIG`（提示下载） |
| `--language <code>` | auto | 透传 whisper `-l` |

data：`{ "path": string, "durationSec": number, "segments": number, "language": string }`

### 3.2 azure-image（Azure OpenAI gpt-image-2）

**`image-gen`** — 生图（有 `--ref` 走 images/edits，无则 images/generations）

| 选项 | 默认 | 说明 |
|---|---|---|
| `--prompt <text>` | 必填 | 文案 |
| `--ref <paths...>` | 无 | 参考图（可多个）；走 edits 端点 |
| `--size <WxH>` | 1024x1024 | 如 1536x1024 |
| `--output <path>` | `./generated-<ts>.png` | 输出图片 |
| `--quality <q>` | `AZURE_IMAGE_QUALITY` | 覆盖默认质量 |

data：`{ "path": string, "bytes": number, "format": string, "size": string, "revisedPrompt"?: string, "account": { "index": number, "endpoint": string } }`（endpoint 不含 key）

### 3.3 suno-music（open.suno.cn 任务制 API）

**`suno-gen`** — 文生音乐：`--prompt <灵感描述>` 或 `--lyrics <自定义歌词>`（二选一必填，否则 `E_MISSING_ARGUMENT`），`--tags`、`--title`、`--model`（默认 `chirp-hawk`）、`--instrumental`、`--no-wait`、`--timeout <sec>`（默认 600）、`--output <path>`
- 等待模式 data：`{ "tracks": [{ "taskId", "customId"?, "title"?, "durationSec"?, "path"?, "bytes"? }], "failed": [{ "taskId", "reason" }] }`——每次生成 2 首，有任一首落盘即 exit 0；全部失败 → `E_PROVIDER_ERROR`
- `--no-wait` data：`{ "taskIds": [number, number] }`
- 轮询超时 → `E_PROVIDER_ERROR`，`details.taskIds` 保留供 `suno-download` 恢复

**`suno-sound`** — 文生音效：`--text <描述>`（必填，映射 title）、`--tags`、`--loop`、`--model <chirp-crow\|chirp-fenix>`、`--no-wait`、`--timeout`、`--output`；走 `POST /api/v1/music/sound`，其余语义同 `suno-gen`。

**`suno-task`** — 查询任务：`--id <taskId>`（必填）。data：`{ "taskId", "status": "pending"|"processing"|"completed"|"failed", "title"?, "durationSec"?, "audioUrl"?, "coverUrl"?, "customId"? }`

**`suno-download`** — 补下载：`--id <taskId>`、`--output <path>`（必填）。仅 `completed` 任务有音频；否则 `E_PROVIDER_ERROR`。

**`suno-balance`** — 查积分。data：`{ "remainingPoints": number }`

### 3.4 suno API 参考（已核实，open.suno.cn/api-guide）

| 端点 | 说明 |
|---|---|
| `POST /api/v1/music/generate` | 文生音乐；灵感模式 `gpt_description_prompt` / 自定义 `prompt`+`tags`；`mv`=模型；`make_instrumental`；响应 `data.task_ids[]` |
| `POST /api/v1/music/sound` | 音效；`title`+`tags`+`mv`（仅 chirp-crow/chirp-fenix）+`tempo`/`key`/`loop` |
| `GET /api/v1/music/task?id=` | 单查；状态 `pending/processing/completed/failed`；官方建议 5–10s 轮询 |
| `GET /api/v1/music/tasks?ids=` | 批量查（本插件不用，保留参考） |
| `GET /api/v1/points/balance` | 余额 → `data.remaining_points` |

结果字段：音频 `result.fileInfo.mp3Url`（**限时 1 小时**，完成即下载）、封面 `result.fileInfo.cosUrl`、时长 `result.fileInfo.duration`、后续操作 ID `result.custom_id`（UUID，区别于数字 task_id）。
认证：`Authorization: Bearer <SUNO_API_KEY>`。
错误映射：401/403 → `E_CONFIG`（key 无效）；402（积分不足）→ `E_PROVIDER_ERROR`（`details.reason="insufficient_points"`）；其余非 2xx → `E_PROVIDER_ERROR`。

## 4. 环境变量契约

| 插件 | 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| media-av | `FFMPEG_PATH` / `FFPROBE_PATH` | 否 | PATH 查找 | 二进制覆盖；缺失 → `E_MISSING_DEPENDENCY` |
| media-av | `WHISPER_CPP_BIN` | 否 | PATH 查找 `whisper-cli`，回退 `whisper-cpp` | 同上 |
| media-av | `WHISPER_MODEL` | transcribe 必填 | — | ggml 模型路径；缺失 → `E_CONFIG` |
| azure-image | `AZURE_IMAGE_KEY_POOL` | 是 | — | 英文逗号分隔多 key |
| azure-image | `AZURE_IMAGE_ENDPOINT_POOL` | 是 | — | 英文逗号分隔多 endpoint，与 KEY_POOL 按索引配对 |
| azure-image | `AZURE_IMAGE_DEPLOYMENT` | 否 | `gpt-image-2` | 部署名 |
| azure-image | `AZURE_IMAGE_OUTPUT_FORMAT` | 否 | `png` | png/jpeg/webp |
| azure-image | `AZURE_IMAGE_QUALITY` | 否 | `auto` | auto/low/medium/high |
| azure-image | `AZURE_IMAGE_API_VERSION` | 否 | `2025-04-01-preview` | gpt-image-2 若要求更新版本，设此 env 即可 |
| suno-music | `SUNO_API_KEY` | 是 | — | Bearer token |
| suno-music | `SUNO_BASE_URL` | 否 | `https://open.suno.cn` | mock 测试入口 |
| suno-music | `SUNO_POLL_INTERVAL_MS` | 否 | `5000` | 轮询间隔 |
| suno-music | `SUNO_TIMEOUT_MS` | 否 | `600000` | 等待总超时 |

## 5. 错误码增量（阶段 01 登记 `src/core/errors.ts`，同步壳 00-master-plan §4.4）

只可新增、不可改名删除；三者均退出码 3（命令执行错误）：

| 错误码 | 含义 | 典型场景 |
|---|---|---|
| `E_CONFIG` | 配置缺失/非法 | key 池长度不等、key 无效（suno 401）、whisper 模型缺失 |
| `E_MISSING_DEPENDENCY` | 外部二进制缺失 | ffmpeg/ffprobe/whisper.cpp 不在 PATH 且无 env 覆盖（details 带安装提示） |
| `E_PROVIDER_ERROR` | 外部提供方执行失败 | 远端 API 非 2xx、ffmpeg/whisper 进程失败（`details.source` 标明 `ffmpeg`/`whisper`/`azure`/`suno`） |

插件抛错方式（D7，鸭子类型）：`throw Object.assign(new Error(msg), { code: "E_CONFIG", details: {...} })`，壳按码分类；未带码 → `E_INTERNAL`。
插件降级警告复用码空间，如 ffmpeg 缺 drawtext 时 push `{ code: "E_MISSING_DEPENDENCY", message: "..." }` 并继续出图。

## 6. 外部依赖与降级

| 依赖 | 用途 | 缺失行为 |
|---|---|---|
| ffmpeg / ffprobe（系统包或 brew install ffmpeg） | media-av 全部命令 | `E_MISSING_DEPENDENCY` + 安装提示 |
| ffmpeg 编译含 drawtext（libfreetype） | 胶片图时间戳 | 降级为无时间戳 + 警告，命令仍成功 |
| whisper.cpp（whisper-cli）+ ggml 模型 | media-transcribe | 二进制缺 → `E_MISSING_DEPENDENCY`；模型缺 → `E_CONFIG` |
| Node >= 20 原生 fetch/FormData/Blob | azure-image / suno-music | 无新增 npm 依赖（两插件零依赖） |

## 7. 阶段索引（严格串行 01→04）

| 阶段 | 文档 | 目标 | 依赖 |
|---|---|---|---|
| 01 | `01-shell-hardening.md` | 壳补强（错误码+鸭子类型抛错）与根目录残留清理、hello 示例 | 无 |
| 02 | `02-media-av.md` | media-av 插件：filmstrip / to-audio / transcribe | 01 |
| 03 | `03-azure-image.md` | azure-image 插件：池调度 + generations/edits | 01 |
| 04 | `04-suno-music.md` | suno-music 插件：提交/轮询/下载 + 辅助命令 | 01 |
| 05 | `05-npm-publish.md` | npm 发布准备：bundled 插件源 + `@dkplus/media-cli` 元数据 | 01–04 |

（02–04 仅依赖 01，但按 §8 协议严格串行执行。）

## 8. 执行协议（planner 编排 + 主 agent 执行）

本方案执行期与壳阶段（多 coding-agent 并行）不同，按用户指定：

1. **planner** 为高级指挥与编排：读取阶段文档，拆解为有序任务（文件清单 + 实现要点 + 禁止事项），逐步派发并在关键节点（删除操作、错误码登记、验收）复核。
2. **主 agent** 为唯一执行者：按 planner 派发顺序串行实现，遵守 AGENTS.md 全部硬约束（stdout/stderr 分离、错误码只增、分层依赖、300 行拆分、声明式注册器、无交互 prompt）。
3. 每阶段完成：主 agent 执行该阶段「验收标准」bash 块并回报证据 → commit（`media-NN: 摘要`）→ 进入下一阶段。全部完成后统一 push。

## 9. 全局验收标准（Definition of Done）

- [ ] `pnpm lint && pnpm build && pnpm test` 全绿（Node >= 20）
- [ ] `node dist/common-cli.js --json spec` 列出全部 9 个 media 命令（source 为 `plugin:<name>`）
- [ ] 9 个命令的 `--json` 成功/失败包络均符合壳契约；新增 3 错误码已登记两处错误码表
- [ ] e2e 全部通过 mock 服务器/本地 fixture 验证，不依赖真实 key 与外网
- [ ] 根目录残留拷贝已删除，`./plugins/` 为真实容器目录且含 hello 与三业务插件
- [ ] `AGENTS.md`、壳的 `docs/plans/00-master-plan.md` 错误码表、`README.md`、`docs/plugin-development.md` 已同步
