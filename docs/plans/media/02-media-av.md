# 阶段 02 — media-av 插件（本地 ffmpeg 系转化）

> 前置依赖：阶段 01（E_MISSING_DEPENDENCY / E_PROVIDER_ERROR / E_CONFIG 已登记，鸭子类型抛错可用）。目标：三个本地转化命令——视频转 4×4 胶片图、视频转音频、音频转 SRT 字幕（D2/D5/D9/D10）。

## 范围

做：`media-filmstrip` / `media-to-audio` / `media-transcribe` 三命令 + 插件内 lib（ffmpeg/whisper/二进制探测）；e2e（本地 fixture，条件跳过）。
不做：API 系 ASR（D2 已定本地 whisper.cpp）；多张网格/按间隔采帧（D5 已定均匀 16 帧）；字幕翻译/格式转换；任何新增 npm 依赖。

## 插件结构（manifest 入口 + 可拆分 lib，纯 .mjs）

```
plugins/media-av/
  index.mjs        # manifest：3 命令声明；handler 全部只 return 数据 / throw 带码 Error
  lib/paths.mjs    # 二进制解析与检测（D10）
  lib/ffmpeg.mjs   # spawn 封装 + ffprobe 取时长/元数据
  lib/whisper.mjs  # whisper.cpp 调用 + SRT 读回
```

约定：handler 不写流、不调 `process.exit`；文件读写用 `node:fs/promises`；临时文件放 `os.tmpdir()` 并在 finally 清理；spawn 用 `node:child_process` 的 `execFile`（参数数组，**禁止** shell 字符串拼接——路径可能含空格）。

## 任务清单

### T1 `lib/paths.mjs` — 二进制探测（D10）

- 解析顺序：env（`FFMPEG_PATH` / `FFPROBE_PATH` / `WHISPER_CPP_BIN`）→ PATH 查找（`which` 语义：遍历 `PATH` 目录测存在性与可执行位）。
- whisper 二进制默认先找 `whisper-cli`，回退 `whisper-cpp`。
- 找不到 → `throw` 带 `code: "E_MISSING_DEPENDENCY"` 的 Error，`details: { dependency: "ffmpeg", hint: "brew install ffmpeg 或设置 FFMPEG_PATH" }`（各依赖给对应 hint）。
- `WHISPER_MODEL` 在 transcribe 时才校验：env 与 `--model-path` 均无 → `E_CONFIG`（details 提示下载 ggml 模型，如 base/small/medium）；文件不存在 → `E_CONFIG`。

### T2 `lib/ffmpeg.mjs` — spawn 封装

- `runFfmpeg(args)` / `runFfprobe(args)`：`execFile`，非 0 退出或 spawn 错误 → `E_PROVIDER_ERROR`，`details: { source: "ffmpeg", exitCode, stderr 摘要（末 10 行）}`。
- `probeDuration(file)`：`ffprobe -v error -show_entries format=duration -of json`，解析失败/无流 → `E_PROVIDER_ERROR`。
- 单文件超 300 行拆分由 lib 结构天然规避。

### T3 `media-filmstrip` — 胶片图（D5）

- `--input` 缺失 → `E_MISSING_ARGUMENT`；`--cell-width` clamp 到 160–640；`--format` 白名单外 → `E_INVALID_OPTION`。
- 输入探测：ffprobe 确认可读并取 `durationSec`（≤ 0 → `E_INVALID_OPTION`）。
- drawtext 可用性检测：`ffmpeg -hide_banner -filters` 输出含 `drawtext` 才启用；否则降级（无时间戳）并 `ctx.warnings.push({ code: "E_MISSING_DEPENDENCY", message: "ffmpeg 未编译 drawtext，时间戳已省略" })`，命令仍成功。
- 滤镜链（均匀按时间采样，保持**原始 pts** 供 drawtext 显示真实时间点）：
  `select='isnan(prev_selected_t)+gte(t-prev_selected_t,D/16)',drawtext=text='%{pts\:hms}':x=8:y=h-th:fontsize=h/28:fontcolor=white:box=1:boxcolor=black@0.5,scale=<cell-width>:-2,tile=4x4`
  （D = durationSec；drawtext 位于 scale 前以随格缩放；降级时去掉 drawtext 节点）
- 输出参数：`-frames:v 1 -q:v 3`（jpg）/ png 无损；`--output` 缺省 `<input>.filmstrip.jpg|png`。
- data（契约见 master-plan §3.1）：`{ path, width, height, cells: 16, durationSec, timestamps }`；width/height 读取输出文件实际尺寸（可用 `ffprobe -show_streams` 对图片）。

### T4 `media-to-audio` — 视频转音频

- 编码映射：mp3→`libmp3lame -b:a <bitrate>`；m4a→`aac -b:a <bitrate>`；wav→`pcm_s16le`；flac→`flac`；ogg→`libvorbis -q:a 4`（bitrate 仅对 mp3/m4a 生效）。
- 核心参数：`ffmpeg -y -i <input> -vn -map a:0? -acodec <codec> <output>`；ffmpeg 失败 → `E_PROVIDER_ERROR`。
- data：`{ path, format, durationSec, bytes }`（bytes 用 `fs.stat`）。

### T5 `lib/whisper.mjs` + `media-transcribe` — 音频转 SRT

- 步骤：ffmpeg 转 16k mono wav 临时文件（`-ar 16000 -ac 1 -c:a pcm_s16le`，写 `os.tmpdir()`）→ `whisper-cli -m <model> -f <tmp.wav> -osrt -of <tmpdir 前缀>`（`--language` 非 auto 时透传 `-l`）→ 读回 `<前缀>.srt` → 写 `--output` → finally 清理临时文件。
- whisper 非 0 退出 → `E_PROVIDER_ERROR`（`details.source: "whisper"`）。
- data：`{ path, durationSec, segments, language }`；segments 数从 SRT 序号最大值解析。

### T6 e2e `tests/e2e/media-av.e2e.test.ts`

- 顶层 `describe.skipIf(!hasFfmpeg)`（beforeAll 探测 `FFMPEG_PATH ?? which ffmpeg`）；whisper 相关用例再 `skipIf(!hasWhisper || !WHISPER_MODEL)`——真实模型不可用时自动跳过，CI 无 ffmpeg/whisper 也能全绿。
- fixture 现场生成（不提交二进制）：beforeAll 用 ffmpeg 生成 3s 彩条视频（`testsrc=duration=3:size=320x240:rate=10`）与 2s 正弦波音频（`sine=frequency=440:duration=2`）到临时目录。
- 断言（全部走 `--json`）：filmstrip 成功 → `data.cells===16`、文件存在、`durationSec≈3`；to-audio → 文件存在且 `bytes>0`；transcribe（whisper 可用时）→ srt 文件存在且含 `-->`。
- 无条件可测的错误分支（不依赖真实二进制）：`FFMPEG_PATH=/nonexistent` 强制 → `E_MISSING_DEPENDENCY`、exit 3；缺 `--input` → `E_MISSING_ARGUMENT`、exit 2；`--format xyz` → `E_INVALID_OPTION`。

### T7 文档同步

- `README.md`：新增 media-av 小节（三命令示例 + 依赖安装提示 + env 表）。

## 执行方式（planner 编排 + 主 agent 执行）

planner 按 T1→T7 顺序派发（T1/T2 是地基，T3 最难先于 T4/T5）；主 agent 串行执行。禁止事项：不引入 npm 依赖；不 shell 拼接路径；不把二进制 fixture 提交进仓库；handler 不触碰 stdout/stderr。完成跑验收块，commit `media-02: media-av plugin with filmstrip, to-audio, transcribe`。

## 验收标准（主 agent 执行并回报证据）

```bash
pnpm lint && pnpm build && pnpm test                  # 全绿（whisper 用例按环境自动跳过）
# 生成样例视频后（tests 内部会生成，以下为手动冒烟，样例路径自备）：
node dist/common-cli.js --json media-filmstrip --input sample.mp4 --output /tmp/grid.jpg
#   退出 0；data.cells===16；/tmp/grid.jpg 为 4 列×4 行拼图，每格含 mm:ss 时间戳
node dist/common-cli.js --json media-to-audio --input sample.mp4 --format m4a --output /tmp/a.m4a
#   退出 0；/tmp/a.m4a 存在
node dist/common-cli.js media-transcribe --input sample.mp3 --output /tmp/a.srt   # whisper 就绪时
#   human 模式输出路径；/tmp/a.srt 为合法 SRT
FFMPEG_PATH=/nonexistent node dist/common-cli.js --json media-to-audio --input x.mp4
#   exit 3；error.code === "E_MISSING_DEPENDENCY"；details.hint 含安装提示
node dist/common-cli.js --json media-filmstrip        # exit 2；error.code === "E_MISSING_ARGUMENT"
node dist/common-cli.js --json spec | grep media-     # spec 含三个 media-* 命令，source 为 plugin:media-av
```
