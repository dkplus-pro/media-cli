# 第一阶段 Media CLI

第一阶段提供 21 个命令：音频 6 个、视频 8 个、图片 7 个。公开包为
`@dkplus/dk-audio`、`@dkplus/dk-video`、`@dkplus/dk-image`，对应二进制命令为
`dk-audio`、`dk-video`、`dk-image`。

本阶段明确不包含图片或视频生成：没有 `generate` 命令，也没有生成 API。
图片生成仅保留为第二阶段的设计概念，当前未实现、未暴露。

## 前置条件

安装 Node.js `>=20.19.5`、通过 Corepack 安装的 pnpm，并确保 `ffmpeg` 与
`ffprobe` 位于 `PATH`。它们用于本地音视频元数据、音频提取和视频胶片流。
media-core 的程序化调用可以覆盖可执行文件路径；CLI 使用者应在 `PATH` 中提供
这两个工具。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

## 命令契约

所有二进制命令均支持以下全局选项：

| 选项               | 含义                                             |
| ------------------ | ------------------------------------------------ |
| `--help` (`-h`)    | 显示用法与命令帮助。                             |
| `--version` (`-V`) | 显示 CLI 版本。                                  |
| `--schema`         | 返回所选命令的输入/输出 Schema。                 |
| `--config <path>`  | 为需要 AI 的命令加载显式 JSON Profile 文件。     |
| `--json`           | 输出一个最终 JSON 结果包络。                     |
| `--jsonl`          | 输出 JSON Lines 进度事件，随后输出一个结果包络。 |
| `--quiet`          | 抑制非必要诊断信息。                             |
| `--verbose`        | 输出详细诊断信息。                               |
| `--force`          | 允许明确支持覆盖的输出操作。                     |
| `--no-cache`       | 禁用缓存结果。                                   |

`--json` 与 `--jsonl` 互斥。使用 `--schema --json` 可以让机器读取单个命令的
契约，无需在调用方维护重复的 Schema。帮助和版本在选择 JSON 输出模式时也使用
结果包络。

正常情况下 stdout 只输出一个 JSON 包络，诊断信息写入 stderr；成功退出码为
`0`，失败为 `1`。

```json
{
  "success": true,
  "command": "music metadata",
  "version": "0.1.0",
  "data": {}
}
```

```json
{
  "success": false,
  "command": "music metadata",
  "version": "0.1.0",
  "error": {
    "code": "MEDIA_TOOL_UNAVAILABLE",
    "message": "Required media tool is unavailable."
  }
}
```

使用 `--jsonl` 时，最终包络前会出现形如
`{"type":"progress","stage":"execute"}` 的进度记录。

## 命令列表

### 音频 — 6 个命令

| 命令                                                              | 必需输入/选项           | 结果                             |
| ----------------------------------------------------------------- | ----------------------- | -------------------------------- |
| `dk-audio speech transcribe <audio>`                              | 原始音频 Adapter        | 规范化且带指纹的 transcript。    |
| `dk-audio speech translate <transcript-or-audio> --to <language>` | `--to`                  | 翻译后的规范 transcript。        |
| `dk-audio speech summarize <transcript>`                          | AI Profile              | 有类型的摘要。                   |
| `dk-audio music metadata <audio>`                                 | 本地 `ffprobe`          | 确定性音频元数据。               |
| `dk-audio music emotion <audio>`                                  | AI Profile              | 有类型的音乐情绪。               |
| `dk-audio music analyze <audio>`                                  | AI Profile 与 `ffprobe` | 严格为 `{ metadata, emotion }`。 |

原始音频是 adapter-only 行为。`speech transcribe` 必须注入原始音频转写器；
`speech translate <audio>` 会组合该转写器和注入的 transcript 翻译器。两者都
不会把原始音频发送给 Qwen-compatible Chat endpoint，也不会因为传入 `--config`
而自动启用。基于 transcript 的翻译和摘要使用规范 transcript 契约。

### 视频 — 8 个命令

| 命令                                                                                                                                                  | 必需输入/选项              | 结果                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------- |
| `dk-video probe <video>`                                                                                                                              | 本地 `ffprobe`             | 带指纹的 video-probe artifact。     |
| `dk-video audio <video> --output <audio>`                                                                                                             | `ffmpeg`、输出路径         | 带指纹的 extracted-audio artifact。 |
| `dk-video filmstrip <video> --output <image>`                                                                                                         | `ffmpeg`、输出路径         | 四帧、带指纹的 filmstrip artifact。 |
| `dk-video subtitles <video>`                                                                                                                          | `ffmpeg`、原始音频 Adapter | 规范 transcript。                   |
| `dk-video content summary <video> --transcript <json> --filmstrip <json>`                                                                             | 匹配 artifact、AI Profile  | 视频内容摘要 artifact。             |
| `dk-video content keywords <video> --transcript <json> --filmstrip <json>`                                                                            | 匹配 artifact、AI Profile  | 视频内容关键词 artifact。           |
| `dk-video content highlights <video> --transcript <json> --filmstrip <json>`                                                                          | 匹配 artifact、AI Profile  | 带时间戳的 highlights artifact。    |
| `dk-video analyze <video> --probe <json> --audio <json> --filmstrip <json> --subtitles <json> --summary <json> --keywords <json> --highlights <json>` | 上述全部 artifact          | 只组合这些显式提供的 artifact。     |

`subtitles` 先提取临时音频，再使用同一个注入式原始音频转写器。内容 artifact 的
source fingerprint 必须与目标视频相同；混用不同视频会报
`ARTIFACT_SOURCE_MISMATCH`。`analyze` 从不创建前置 artifact，缺失时会报
`MISSING_REQUIRED_ARTIFACT`。胶片流输出若已存在，必须传入 `--force` 才能覆盖。

### 图片 — 7 个命令

| 命令                                                        | 必需输入/选项      | 结果                                                   |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| `dk-image content metadata <image>`                         | 本地图片           | 确定性元数据。                                         |
| `dk-image content describe <image>`                         | AI Profile         | 图片描述。                                             |
| `dk-image content keywords <image>`                         | AI Profile         | 关键词。                                               |
| `dk-image content ocr <image>`                              | AI Profile         | 可见文字与 blocks。                                    |
| `dk-image content score <image>`                            | AI Profile         | 0 到 10 的评分与理由。                                 |
| `dk-image analyze <image>`                                  | AI Profile         | 严格组合 metadata、description、keywords、OCR、score。 |
| `dk-image watermark <image> --output <image> --text <text>` | 不同输出路径与文字 | 水印图片 artifact。                                    |

水印为仅输出操作：未提供 `--force` 时拒绝覆盖已有输出，并且永远拒绝与输入图片
解析为同一路径的输出。

## AI Profile

启用 AI 的 CLI 命令只读取 `--config` 指定的 JSON 文件，不读取也不打印进程环境
中的凭据。请将该文件排除在版本控制外，并通过密钥管理流程替换占位符。每个 Profile
必须有唯一 `id`、精确 Feature ID 或 `.*` Feature 模式，以及 `azure` 或
`openai-compatible` provider；第一个匹配 Feature 的 Profile 生效。

```json
{
  "profiles": [
    {
      "id": "azure-content",
      "provider": "azure",
      "features": ["audio.speech.summarize", "video.content.*", "image.content.*"],
      "config": {
        "endpoint": "https://YOUR_RESOURCE.openai.azure.com",
        "apiKey": "<AZURE_OPENAI_API_KEY>",
        "deployment": "<AZURE_OPENAI_DEPLOYMENT>",
        "apiVersion": "2024-10-21"
      }
    },
    {
      "id": "qwen-content",
      "provider": "openai-compatible",
      "features": ["audio.music.*"],
      "config": {
        "baseUrl": "<DASHSCOPE_BASE_URL>",
        "apiKey": "<DASHSCOPE_API_KEY>",
        "model": "<DASHSCOPE_MODEL>"
      }
    }
  ]
}
```

当前 live-test provider 支持下列环境变量（只提供变量名，绝不在文档或提交的配置中
放入变量值）：

| Provider        | 标准变量名                                                                                             | 兼容别名                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Azure OpenAI    | `AZURE_OPENAI_ENDPOINT`、`AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_DEPLOYMENT`、`AZURE_OPENAI_API_VERSION` | `AZURE_OPENAI_BASE_URL`、`AZURE_OPENAI_KEY`、`AZURE_OPENAI_MODEL`、`AZURE_OPENAI_VERSION` |
| Qwen-compatible | `DASHSCOPE_BASE_URL`、`DASHSCOPE_API_KEY`、`DASHSCOPE_MODEL`                                           | `QWEN_BASE_URL`、`QWEN_API_KEY`、`QWEN_MODEL`                                             |

## 测试与包消费验证

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:live
pnpm test:smoke
```

`pnpm test:live` 默认安全跳过：只有环境中已经注入 `DKPLUS_LIVE_AI=1` 才会执行
真实 provider 测试。启用后，Azure 或 Qwen-compatible 变量必须由外部环境提供。
不要在命令、Profile 示例、测试输出或 issue 中粘贴凭据。原始音频转写和直接音频
翻译在专用 ASR Profile 出现前，明确不属于 Qwen-compatible Chat live matrix。

`pnpm test:smoke` 会构建公开包、打包全部公开包、将归档安装到一次性离线 consumer、
验证包内容，并从已安装的 consumer 运行 `dk-audio --help`、`dk-image --help` 与
`dk-video --help`。CI 在 format、lint、typecheck、非 live test、build 后运行此
non-live smoke 检查，绝不运行 `test:live`。
