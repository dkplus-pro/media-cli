# @dkplus/dk-audio

`dk-audio` 是可发布的 ESM 包和命令行工具，提供第一阶段音频能力：转写、
规范 Transcript 翻译与总结，以及确定性音乐元数据和 AI 路由的音乐情绪分析。

## 安装与使用

```bash
pnpm add @dkplus/dk-audio
dk-audio --help
dk-audio describe --json
dk-audio speech summarize transcript.json --json
dk-audio music metadata song.wav --json
dk-audio music analyze song.wav --jsonl
dk-audio speech translate transcript.json --to zh --json
```

所有命令支持 `--help`、`--version`、`--schema`、`--config <path>`、`--json`、
`--jsonl`、`--quiet`、`--verbose`、`--force` 与 `--no-cache`。普通 JSON 输出始终
只有一个成功或失败信封；出错时退出码为 1。可用
`dk-audio speech summarize --schema --json` 查询命令契约。

## 命令

| 命令 | 输入 | 输出 |
| --- | --- | --- |
| `speech transcribe` | 音频文件 | 规范 Transcript |
| `speech translate --to <language>` | 规范 Transcript | 规范 Transcript |
| `speech summarize` | 规范 Transcript | 类型化总结 |
| `music metadata` | 音频文件 | 确定性元数据 |
| `music emotion` | 音频文件 | 类型化情绪 |
| `music analyze` | 音频文件 | 严格为 `{ metadata, emotion }` |

机器可读清单见 [commands.json](./commands.json)。

## 程序化 API 与配置

`transcribeAudio` 必须注入带有 `audio.speech.transcribe` 功能标识的
`AudioTranscriber`。在应用未提供该适配器时，CLI 会明确返回
`AUDIO_TRANSCRIBER_UNAVAILABLE`；它绝不会把原始音频二进制静默发送给
Qwen 兼容 Chat 接口。

`translateTranscript` 同样需要注入 `TranscriptTranslator`。
`summarizeTranscript` 和 `analyzeMusicEmotion` 接收类型化 `AIProvider`，并分别
使用 `audio.speech.summarize` 和 `audio.music.emotion` 路由。领域包不会读取
API Key、提供商 URL 或环境凭据。

`readAudioMetadata` 从本地 `ffprobe` 数据读取时长、编码、采样率、声道和比特率。
本地不可用的音乐标签（`bpm`、`key`、`mode`、`loudness`）始终是 `null`，不会伪造。

## 校验与测试

翻译和总结输入会通过规范 `Transcript` 契约解析。格式错误会得到
`INVALID_TRANSCRIPT`；缺少适配器或提供商会得到类型化配置错误。测试覆盖帮助、
版本、schema、JSON 信封、格式错误 Transcript、全部六个 API 和六命令清单。

```bash
pnpm --filter @dkplus/dk-audio build
pnpm --filter @dkplus/dk-audio test
pnpm --filter @dkplus/dk-audio typecheck
pnpm --filter @dkplus/dk-audio lint
```
