---
name: media-cli
description: 媒体处理 CLI（@dkplus/media-cli，命令名 media-cli）：抠图/去背景/透明 PNG/主体提取（media-cutout，macOS Vision）、压缩图片/图片瘦身/减小体积不改分辨率（media-compress，sharp）、图片加水印/平铺斜角水印/防盗图/文字水印（media-watermark，支持字体/角度/间距/透明度）、压缩视频/视频瘦身/减小视频体积（media-compress-video，ffmpeg H.264/HEVC）、压缩音频/音频瘦身（media-compress-audio，mp3/m4a/flac）、视频转胶片图/16 帧拼图/视频帧理解（media-filmstrip）、视频转音频/提取音轨（media-to-audio）、音视频转字幕/SRT（media-transcribe，whisper.cpp）、AI 生图/文生图/参考图改图（image-gen，Azure gpt-image-2）、AI 音乐生成/配乐/BGM/音效（suno-gen/suno-sound，Suno）。给人用也给 AI 用：所有命令支持 --json 机器可读输出。用户要求处理图片/视频/音频、压缩或加水印、生成图像或音乐、提取字幕或音轨时使用本 skill。
---

# media-cli（@dkplus/media-cli）

媒体处理与 AI 生成 CLI。安装：`npm i -g @dkplus/media-cli`（需 Node >= 20）。

## 调用契约（AI 必读）

- 一律加 `--json`：stdout 输出单行 JSON 包络，直接 `JSON.parse`。
  - 成功：`{ "ok": true, "data": ..., "warnings": [...] }`
  - 失败：`{ "ok": false, "error": { "code", "message", "details" } }`
- 退出码：`0` 成功；`2` 用法错（E_MISSING_ARGUMENT / E_INVALID_OPTION）；`3` 执行错（E_CONFIG / E_MISSING_DEPENDENCY / E_PROVIDER_ERROR 等）。
- **兜底**：本文档可能滞后，用 `media-cli --json spec` 获取当前版本的完整命令树（name/options/source）——以 spec 为准。
- 非交互：永远不会挂起等待输入；缺必填参数会直接报 E_MISSING_ARGUMENT，不会 prompt。

## 命令速查（按意图）

| 意图 | 命令 | 关键选项 |
|---|---|---|
| 抠图/去背景/透明 PNG/主体提取 | `media-cutout` | `--input <文件或目录>` `--output` `--padding <px=32>` `--no-crop`（保留原画布）`--recursive`（目录递归 mirror） |
| 压缩图片体积（不改分辨率、不转格式） | `media-compress` | `--input <文件或目录>` `--output`（单文件默认 `<name>.min.<ext>`，文件夹默认 `./min`）`--quality <1-100=80>`（PNG 无损不受影响）`--recursive` |
| 图片加水印/平铺斜角文字水印 | `media-watermark` | `--input <文件或目录>` `--text <文案>`（必填）`--font <字体族=sans-serif>` `--angle <deg=30>` `--spacing <px=80>`（相邻水印间距）`--opacity <0-1=0.3>` `--font-size <px=自适应>` `--color <css=#ffffff>` `--output`（单文件默认 `<name>.watermark.<ext>`，文件夹默认 `./watermark`）`--recursive` |
| 压缩视频/视频瘦身 | `media-compress-video` | `--input <文件或目录>` `--output`（单文件默认 `<name>.min.mp4`，文件夹默认 `./min`）`--crf <0-51=26>`（越小质量越高）`--preset <medium>`（越慢压缩率越高）`--codec h264\|hevc` `--max-height <px>`（可选降分辨率，仅缩小）`--audio-bitrate <128k>` `--format mp4\|mov\|mkv` `--recursive` |
| 压缩音频/音频瘦身 | `media-compress-audio` | `--input <文件或目录>` `--output`（单文件默认 `<name>.min.<format>`，文件夹默认 `./min`）`--bitrate <128k>`（仅有损生效）`--format mp3\|m4a\|aac\|opus\|ogg\|flac`（默认有损保持原样、wav/aiff 转 flac）`--recursive` |
| 视频画帧速览（AI 读视频内容） | `media-filmstrip` | `--input <视频>` `--output`（默认 4×4 十六格、每格烧时间戳；`--cell-width` `--format jpg\|png`） |
| 提取音轨/视频转音频 | `media-to-audio` | `--input` `--format mp3\|m4a\|wav\|flac\|ogg` `--bitrate <rate=192k>` |
| 音/视频转字幕 SRT | `media-transcribe` | `--input` `--output` `--language` `--model-path`（默认取 WHISPER_MODEL） |
| 文生图 | `image-gen --prompt <文案>` | `--size 1024x1024` `--output` `--quality` |
| 参考图+文案改图/生图 | `image-gen --prompt ... --ref <图1> <图2>` | 多张参考图走 edits 端点；仅 jpg/jpeg/png/webp |
| 文生音乐/配乐/BGM | `suno-gen` | `--prompt <灵感>` **或** `--lyrics <歌词>`（二选一，互斥）；`--tags` `--title` `--instrumental` `--model` |
| 文生音效 | `suno-sound --text <描述>` | `--tags` `--loop` `--model chirp-crow\|chirp-fenix` |
| 查任务/补下载/查余额 | `suno-task --id` / `suno-download --id --output` / `suno-balance` | 恢复超时任务用 |

## 环境变量前置（缺失即 E_CONFIG / E_MISSING_DEPENDENCY）

| 命令 | 需要 | 说明 |
|---|---|---|
| `media-compress` / `media-watermark` | 无 | sharp 引擎随 npm 包安装，无外部二进制、无环境变量 |
| `media-compress-video` / `media-compress-audio` | ffmpeg（PATH 或 `FFMPEG_PATH`）+ ffprobe | hevc 需 ffmpeg 含 libx265（brew 版自带） |
| `media-filmstrip` / `media-to-audio` | ffmpeg（PATH 或 `FFMPEG_PATH`） | |
| `media-transcribe` | + whisper.cpp（`WHISPER_CPP_BIN`）与 ggml 模型（`WHISPER_MODEL` 或 `--model-path`） | |
| `media-cutout` | **仅 macOS 14+**；首次运行自动 `swiftc` 编译缓存（需 Xcode CLT）；`CUTOUT_BIN` 可覆盖 | 其他平台明确报错，勿在 Linux CI 使用 |
| `image-gen` | `AZURE_IMAGE_KEY_POOL` + `AZURE_IMAGE_ENDPOINT_POOL`（英文逗号分隔，**按索引一一配对**） | `AZURE_IMAGE_DEPLOYMENT=gpt-image-2` `AZURE_IMAGE_OUTPUT_FORMAT=png` `AZURE_IMAGE_QUALITY=auto` 有默认 |
| `suno-*` | `SUNO_API_KEY`（open.suno.cn） | `SUNO_BASE_URL`/`SUNO_TIMEOUT_MS` 可选 |

## 坑位与输出语义

- `suno-gen`/`suno-sound` 默认**阻塞轮询直到完成并自动下载**（音频链接限时 1 小时，无需手动转存）；Suno 每次生成 **2 首**，批量语义见 `data.tracks[]` 与 `data.failed[]`；`--no-wait` 只提交返回 `{ taskIds }`；等待超时报 `E_PROVIDER_ERROR` 且 `details.taskIds` 可用 `suno-download --id` 恢复（积分已扣，务必恢复而不是重发）。
- `media-cutout` / `media-compress` / `media-watermark` 文件夹批量：部分失败不中断，检查 `data.failed[]`（file + reason）；全失败才报错。
- `media-compress` 不 resize、不转格式；PNG 走无损优化（收益有限，大图建议压 jpg/webp）；重编码不比原图小时 `skipped: true` 且**不落盘**（原图永不变大）。EXIF 方向会摆正写进像素，orientation 5-8 的图输出宽高互换属正常（视觉分辨率不变）。
- `media-watermark` 整图斜角平铺水印：`--spacing` 是相邻水印间距 px，`--angle` 默认 30；字体由系统 fontconfig 解析，**字体不存在时静默回退默认字体不报错**；字号默认按最短边 1/24 自适应（14–160）；平铺数上限 20000，间距/字号过小报 `E_INVALID_OPTION` 提示增大 spacing。
- `media-compress-video` 重编码只保留**一条视频轨 + 一条音轨**（字幕、多音轨、章节丢弃，音轨统一转 AAC）；默认 mp4 + faststart（网页边下边播），`--codec hevc` 体积更小但慢且需 libx265；`--max-height` 仅缩小不放大；耗时与时长/分辨率成正比（超时 1 小时报 `E_PROVIDER_ERROR`）。
- `media-compress-audio` 有损格式默认保持原格式重压；wav/aiff 默认转 flac（无损缩小），flac→flac 通常 `skipped: true`。
- A/V 压缩（video/audio）结果不比原文件小时 `skipped: true` 且**回滚不落盘**；**拒绝原地覆盖**（`--output` 与输入相同/输出目录=输入目录报 `E_INVALID_OPTION`，A/V 是流式写文件，与图片的缓冲写不同）。
- `image-gen` 多账号池自动轮换重试（401/403/429/5xx），无需调用方处理；400 类参数错误不轮换直接报 `E_PROVIDER_ERROR`。
- `image-gen --ref` 按扩展名推断 mimetype 传给 Azure，仅支持 jpg/jpeg/png/webp；其他格式（heic、bin 等）本地即报 `E_INVALID_OPTION`（退出码 2），不发请求。HEIC 先转 jpg 再喂。
- `image-gen --size` 非标比例可直接传对应 WxH，不限于 1024/1536 三档（如 4:3 传 `1536x1152` 实测可出图）。
- 胶片图适合喂给多模态模型理解视频：一张图 16 帧、带 `mm:ss` 时间戳，可直接引用「00:42 处」。
- 错误码语义：`E_CONFIG` 配置缺失/非法 → 检查 env；`E_MISSING_DEPENDENCY` 外部二进制缺失 → `details.hint` 有安装提示；`E_PROVIDER_ERROR` 远端/进程失败 → `details.source` 标明来源（ffmpeg/whisper/vision/azure/suno）。
