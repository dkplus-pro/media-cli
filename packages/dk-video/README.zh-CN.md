# @dkplus/dk-video

`dk-video` 是第一阶段的视频 CLI。它严格提供八个命令：确定性视频产物、显式字幕转写、基于 Transcript 的内容分析，以及显式产物组合。

```bash
dk-video probe clip.mp4 --json
dk-video audio clip.mp4 --output clip.wav --json
dk-video filmstrip clip.mp4 --output clip.png --timestamps 0,10,20,30 --json
dk-video subtitles clip.mp4 --json
dk-video content summary clip.mp4 --transcript transcript.json --filmstrip filmstrip.json --config video-ai.json --json
dk-video analyze clip.mp4 --probe probe.json --audio audio.json --filmstrip filmstrip.json --subtitles transcript.json --summary summary.json --keywords keywords.json --highlights highlights.json --json
```

所有命令支持 `--help`、`--version`、`--schema`、`--config <path>`、`--json`、`--jsonl`、`--quiet`、`--verbose`、`--force` 与 `--no-cache`。JSON 模式下 help 和 version 也使用结果信封。普通 JSON 始终仅输出一个最终成功或失败信封；只有 `--jsonl` 才会输出进度事件。

## 命令

| 命令                        | 输出                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `probe`                     | 带指纹的 `video-probe` 产物                                                           |
| `audio --output <path>`     | 带指纹的 `video-audio` 产物                                                           |
| `filmstrip --output <path>` | 带指纹的 `video-filmstrip` 产物，包含引用图片字节                                     |
| `subtitles`                 | 规范且带指纹的 `Transcript`                                                           |
| `content summary`           | `video-content-summary` 产物                                                          |
| `content keywords`          | `video-content-keywords` 产物                                                         |
| `content highlights`        | `video-content-highlights` 产物                                                       |
| `analyze`                   | 仅组合传入的 probe、audio、filmstrip、subtitles、summary、keywords 和 highlights 产物 |

机器可读清单见 [commands.json](./commands.json)。本包没有 `generate` 命令或 API。

## 产物安全与 API

八个导出 API 分别是 `probeVideo`、`extractVideoAudio`、`createVideoFilmstrip`、`extractVideoSubtitles`、`summarizeVideoContent`、`extractVideoKeywords`、`extractVideoHighlights` 和 `analyzeVideo`。

所有视频包装产物都带有源视频的 SHA-256 指纹。`extractVideoSubtitles` 会提取临时本地音频，使用显式注入的 `AudioTranscriber` 调用公开的 `transcribeAudio` API，验证音频 Transcript 后将其重新关联到视频源。未注入 transcriber 时返回 `AUDIO_TRANSCRIBER_UNAVAILABLE`；不会把原始视频或音频发送给通用聊天端点，也不会伪造 Transcript。

filmstrip 输出遵循非破坏性行为：目标路径已存在时会返回 `OUTPUT_EXISTS`，除非设置 `--force`（或 API 传入 `force: true`），此时允许覆盖目标文件。

内容 API 需要规范 `Transcript` 和 `video-filmstrip` 产物，且两者必须与请求视频的源指纹一致。混用不同视频的产物会返回 `ARTIFACT_SOURCE_MISMATCH`。Provider 调用严格使用 `video.content.summary`、`video.content.keywords`、`video.content.highlights` Feature ID，并携带带时间戳的 Transcript 文本及引用的 filmstrip 图片内容。

`analyzeVideo` 不会生成任何前置产物。它只接受显式传入的 probe、audio、filmstrip、subtitles、summary、keywords 和 highlights；缺少任意一项会返回 `MISSING_REQUIRED_ARTIFACT`。

## AI 配置

内容命令通过 `--config` 加载显式 JSON Profile；CLI 不读取或打印环境变量中的密钥。

```json
{
  "profiles": [
    {
      "id": "video-content",
      "provider": "openai-compatible",
      "features": ["video.content.*"],
      "config": {
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "replace-with-a-secret",
        "model": "example-model"
      }
    },
    {
      "id": "azure-video-highlights",
      "provider": "azure",
      "features": ["video.content.highlights"],
      "config": {
        "endpoint": "https://example.openai.azure.com",
        "apiKey": "replace-with-a-secret",
        "deployment": "video-deployment",
        "apiVersion": "2024-10-21"
      }
    }
  ]
}
```

每个 Profile 必须有唯一 ID，并配置一个或多个精确或 `.*` Feature 路由；按数组顺序使用第一个匹配项。缺失或格式错误的配置会返回经过脱敏的类型错误 `AI_CONFIGURATION_INVALID`。

```bash
pnpm --filter @dkplus/dk-video build
pnpm --filter @dkplus/dk-video test
pnpm --filter @dkplus/dk-video typecheck
pnpm --filter @dkplus/dk-video lint
```
