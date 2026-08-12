---
title: 'Monorepo 的 CLI 实现方案：从领域包到可编排媒体能力'
date: 2026-08-12
tags: ['Monorepo', 'CLI', 'npm', '音视频处理', '架构设计']
description: '设计一套可独立发布、可组合、可测试并支持 n8n、Node、Python 和 AI Agent 调用的媒体处理 CLI Monorepo 方案'
draft: false
---

# dkplus Media CLI Monorepo 技术方案

## 1. 项目定位

目标是在现有 `dkplus` monorepo 中建设一套可独立发布、可组合、可测试、可被 n8n / Node / Python / AI Agent 调用的媒体处理 CLI。

整体原则：

> **Package 是领域边界，Command 是原子能力，Apps 是平台与 Demo，Workflow 由外部编排系统负责。**

第一阶段发布三个 npm 包：

```text
@dkplus/dk-audio
@dkplus/dk-video
@dkplus/dk-image
```

分别提供：

```bash
dk-audio ...
dk-video ...
dk-image ...
```

例如：

```bash
dk-audio speech transcribe input.wav
dk-audio music analyze input.mp3

dk-video filmstrip input.mp4
dk-video analyze input.mp4

dk-image analyze input.jpg
dk-image watermark input.jpg
```

这里假设 `dkplus` 同时是 npm scope，即 `@dkplus`。如果 `dkplus` 只是 monorepo 名称而不是 npm Organization，则可以发布为无 scope 的：

```text
dk-audio
dk-video
dk-image
```

如果使用 `@dkplus/*` 且公开发布，npm 要求该 scope 存在且账号拥有相应发布权限；公开 scoped package 可通过 `public` access 发布。

---

# 2. 为什么建议三个领域包，而不是几十个 npm 包

推荐：

```text
@dkplus/dk-audio
@dkplus/dk-video
@dkplus/dk-image
```

而不是：

```text
@dkplus/audio-transcribe
@dkplus/audio-analyze
@dkplus/audio-translate

@dkplus/video-filmstrip
@dkplus/video-summary
...
```

因为当前最合适的边界是：

```text
npm Package
=
安装 / 发布 / 版本边界

Command
=
能力边界
```

所以：

```bash
dk-audio speech transcribe
```

仍然是一个完整的原子能力，并不要求 `transcribe` 自己成为一个 npm package。

这样可以避免未来出现：

```text
40 个 npm packages
40 套 README
40 套 package.json
40 套版本
40 套发版
```

但每个功能依然可以独立测试和调用。

只有某个 Command 后来出现以下情况时，再拆包：

```text
依赖极其庞大
独立团队维护
独立版本周期
独立部署
成为独立产品
被大量其他项目单独依赖
```

例如未来：

```text
audio transcribe
```

演变成完整 Whisper GPU 服务，就可以再抽成：

```text
@dkplus/dk-audio-transcribe
```

第一阶段没有必要。

---

# 3. Monorepo 总体结构

建议在现有架构上增加：

```text
dkplus/
│
├── apps/
│   │
│   ├── media-demo/
│   │
│   ├── video-platform/
│   │
│   ├── music-platform/
│   │
│   └── ...
│
├── packages/
│   │
│   ├── dk-audio/
│   │
│   ├── dk-video/
│   │
│   ├── dk-image/
│   │
│   ├── cli-core/
│   │
│   ├── ai-core/
│   │
│   ├── media-core/
│   │
│   ├── contracts/
│   │
│   └── testing/
│
├── tests/
│   └── integration/
│
├── .changeset/
│
├── pnpm-workspace.yaml
└── package.json
```

其中：

```text
apps/
```

只负责：

* Web 平台
* Demo
* 实际业务系统
* CLI 能力演示
* 集成验证

而：

```text
packages/
```

负责：

* 可以发布的 CLI
* CLI 共用能力
* Contract
* AI Provider
* 测试工具

---

# 4. 哪些 Package 发布 npm

第一阶段建议只有：

```text
packages/dk-audio
packages/dk-video
packages/dk-image
```

设置：

```json
{
  "private": false
}
```

其他：

```text
cli-core
ai-core
media-core
contracts
testing
```

第一阶段可以：

```json
{
  "private": true
}
```

作为 monorepo 内部实现。

这样 npm 上不会出现大量用户不需要理解的内部 package。

后续如果发现：

```text
@dkplus/contracts
```

或者：

```text
@dkplus/ai-core
```

具有独立外部价值，再发布。

---

# 5. 三个 CLI 的统一设计

三个 CLI 必须保持完全一致的使用体验。

例如：

```bash
dk-audio --help
dk-video --help
dk-image --help
```

统一支持：

```text
--help
--version

--config
--json
--jsonl

--quiet
--verbose

--force
--no-cache
```

---

# 6. 统一输出规范

机器调用时：

```bash
dk-video filmstrip input.mp4 --json
```

stdout 只输出：

```json
{
  "success": true,
  "command": "filmstrip",
  "version": "1.2.0",
  "data": {
    "manifest": "./output/manifest.json"
  }
}
```

错误：

```json
{
  "success": false,
  "command": "filmstrip",
  "error": {
    "code": "VIDEO_DECODE_FAILED",
    "message": "Unable to decode video",
    "retryable": false
  }
}
```

约定：

```text
stdout
→ 机器结果

stderr
→ 日志

Exit 0
→ Success

Exit != 0
→ Failed
```

这样：

```text
n8n
Python
Node
Shell
Codex
其他 Agent
```

都能稳定调用。

---

# 7. 长任务增加 JSON Lines

例如：

```bash
dk-video analyze video.mp4 --jsonl
```

输出：

```json
{"type":"progress","stage":"probe","progress":5}
{"type":"progress","stage":"filmstrip","progress":25}
{"type":"progress","stage":"transcribe","progress":55}
{"type":"progress","stage":"ai","progress":80}
{"type":"result","success":true,"data":{}}
```

这样上层平台可以实时显示：

```text
分析中 55%
```

而不需要解析人类日志。

---

# 8. AI 配置体系

AI 不能直接写死：

```text
model = qwen
```

因为同一个 CLI 中，不同 Command 很可能需要不同模型。

例如：

```text
audio speech transcribe
→ Fun-ASR

audio music analyze
→ Qwen Omni

audio speech summarize
→ GPT / Qwen

image analyze
→ Vision Model
```

因此应该设计：

> **AI Profile + Feature Binding**

---

# 9. AI Profile

统一配置文件：

```text
~/.config/dkplus/config.yaml
```

项目级：

```text
.dkplus/config.yaml
```

例如：

```yaml
ai:
  profiles:

    qwen-omni:
      mode: api
      provider: openai-compatible
      baseUrl: https://example.com/v1
      model: qwen3.5-omni-plus
      apiKeyEnv: DASHSCOPE_API_KEY

    gpt:
      mode: api
      provider: openai-compatible
      baseUrl: https://example.openai.azure.com/...
      model: gpt-4o
      apiKeyEnv: AZURE_OPENAI_API_KEY

    local-whisper:
      mode: local
      provider: whisper
      model: large-v3
      device: auto

    local-vision:
      mode: api
      provider: openai-compatible
      baseUrl: http://localhost:11434/v1
      model: local-vision
```

---

# 10. Feature Binding

然后单独定义：

```yaml
features:

  audio.speech.transcribe:
    profile: local-whisper

  audio.speech.summary:
    profile: qwen-omni

  audio.music.emotion:
    profile: qwen-omni

  audio.music.instrumentation:
    profile: qwen-omni

  video.content.summary:
    profile: gpt

  image.content.analyze:
    profile: gpt
```

这样：

```text
Command
↓
Feature ID
↓
AI Profile
↓
真正模型
```

一项功能完全不用知道 API Key 和 URL。

---

# 11. CLI 临时覆盖模型

也应该允许：

```bash
dk-audio music analyze song.wav \
  --ai-profile qwen-omni
```

甚至：

```bash
dk-audio music analyze song.wav \
  --ai-mode api \
  --ai-base-url http://localhost:8000/v1 \
  --ai-model my-model
```

但不要要求用户每次输入。

推荐配置优先级：

```text
CLI 参数
   ↓
环境变量
   ↓
项目 .dkplus/config.yaml
   ↓
用户 ~/.config/dkplus/config.yaml
   ↓
CLI 默认值
```

---

# 12. API Key

支持：

```yaml
apiKey: xxx
```

但不推荐。

优先：

```yaml
apiKeyEnv: DASHSCOPE_API_KEY
```

然后：

```bash
export DASHSCOPE_API_KEY=xxx
```

这样不会因为把：

```text
.dkplus/config.yaml
```

提交 Git 而泄露 Key。

---

# 13. `dk-audio` 命令设计

建议先分两大 Namespace：

```text
speech
music
```

---

# 14. 普通语音

## 字幕识别

```bash
dk-audio speech transcribe input.wav
```

支持：

```text
txt
json
srt
vtt
```

例如：

```bash
dk-audio speech transcribe input.wav \
  --format srt \
  --output transcript.srt
```

未来支持：

```text
speaker diarization
language detection
word timestamp
hotwords
```

---

## 翻译

```bash
dk-audio speech translate transcript.srt \
  --to en
```

推荐：

```text
Transcript
→ Translate
```

不要强制重新读取 Audio。

也允许 convenience：

```bash
dk-audio speech translate input.wav \
  --to en
```

内部自动：

```text
transcribe
↓
translate
```

---

## 对话情感

```bash
dk-audio speech emotion transcript.json
```

输出例如：

```json
{
  "overall": "positive",
  "segments": [
    {
      "speaker": "speaker_1",
      "emotion": "excited"
    }
  ]
}
```

---

## 内容总结

```bash
dk-audio speech summarize transcript.json
```

输出：

```text
summary
topics
keyPoints
participants
decisions
questions
```

---

# 15. 音乐分析

命令建议：

```bash
dk-audio music metadata song.wav

dk-audio music emotion song.wav

dk-audio music keywords song.wav

dk-audio music instruments song.wav

dk-audio music structure song.wav

dk-audio music texture song.wav

dk-audio music trajectory song.wav

dk-audio music narrative song.wav

dk-audio music scenes song.wav
```

其中：

### metadata

负责确定性信息：

```text
duration
codec
sample rate
channels
bitrate
BPM
key
mode
loudness
```

优先 DSP，而不是让 LLM 猜。

---

### emotion

```text
primary emotion
secondary emotions
valence
arousal
tension
```

---

### keywords

例如：

```text
cinematic
nostalgic
piano
warm
slow-build
```

---

### instruments

分析：

```text
Piano
Strings
Percussion
Synth
Choir
...
```

---

### structure

例如：

```text
Intro
Theme
Build
Climax
Drop
Outro
```

必须带时间。

---

### texture

例如：

```text
Warm
Cold
Dark
Bright
Organic
Synthetic
Spacious
Intimate
Dense
Minimal
```

---

### trajectory

例如：

```text
Flat

Slow Build

Build → Climax

Build → Climax → Resolve

Multiple Peaks
```

---

### narrative

面向剪辑：

```text
Opening
Atmosphere
Reflection
Memory
Build
Suspense
Conflict
Climax
Triumph
Resolution
Ending
```

---

### scenes

输出：

```text
recommendedScenes
notRecommendedScenes
```

---

# 16. 音乐综合分析

核心命令：

```bash
dk-audio music analyze song.wav
```

不是重新发明新的分析逻辑。

而是组合：

```text
metadata
emotion
keywords
instruments
structure
texture
trajectory
narrative
scenes
```

最终：

```json
{
  "metadata": {},
  "emotion": {},
  "keywords": [],
  "instruments": [],
  "structure": {},
  "texture": [],
  "trajectory": {},
  "narrative": [],
  "scenes": {}
}
```

所以：

> 小 Command 是原子能力，`analyze` 是官方组合能力。

---

# 17. `dk-video` 命令设计

建议 Namespace：

```text
media
content
edit
```

也可以保持一级 Command 简洁。

第一版建议：

```bash
dk-video probe

dk-video audio

dk-video filmstrip

dk-video subtitles

dk-video analyze

dk-video script

dk-video draft

dk-video talking-head
```

---

# 18. 视频基础工具

## 转音频

```bash
dk-video audio input.mp4 \
  --output audio.wav
```

内部 FFmpeg。

---

## 胶片流

```bash
dk-video filmstrip input.mp4
```

支持：

```text
4x4
3x3
segment duration
timestamps
output quality
```

例如：

```bash
dk-video filmstrip video.mp4 \
  --grid 4x4 \
  --segment 90
```

---

## 字幕

```bash
dk-video subtitles video.mp4
```

内部应复用：

```text
@dkplus/dk-audio
```

能力。

逻辑：

```text
extract audio
↓
audio speech transcribe
```

而不是视频包再实现一套 ASR。

---

# 19. 视频内容分析

建议拆：

```bash
dk-video content summary

dk-video content metadata

dk-video content keywords

dk-video content subtitles

dk-video content overlays

dk-video content highlights

dk-video content usage

dk-video content narrative
```

---

## summary

```bash
dk-video content summary \
  --filmstrip ./filmstrip.json \
  --transcript ./transcript.json
```

推荐优先接受**已经存在的分析中间产物**。

不要默认：

```text
summarize
↓
偷偷重新抽帧
↓
偷偷重新 ASR
```

这样 n8n 才方便自由组合。

同时可以提供 convenience：

```bash
dk-video analyze video.mp4
```

执行完整流程。

---

## 精彩片段

```bash
dk-video content highlights ...
```

返回：

```json
[
  {
    "start": 31.2,
    "end": 47.8,
    "type": "reaction",
    "reason": "..."
  }
]
```

---

## 素材用途

例如：

```text
A-Roll
B-Roll
Interview
Dialogue
Reaction
Establishing
Detail
Atmosphere
Transition
Ending
```

---

## 叙事功能

例如：

```text
Opening
Introduction
Context
Journey
Discovery
Experience
Reaction
Highlight
Conclusion
Ending
```

---

## 口播花字

```bash
dk-video content overlays ...
```

输出：

```text
timestamp
text
style intent
importance
```

只生成建议，不负责真正做 AE 动画。

---

# 20. 视频综合分析

```bash
dk-video analyze video.mp4
```

组合：

```text
probe
filmstrip
subtitles
summary
keywords
highlights
usage
narrative
```

允许：

```bash
dk-video analyze video.mp4 \
  --skip subtitles
```

或者：

```bash
dk-video analyze video.mp4 \
  --only summary,keywords,highlights
```

---

# 21. 生成视频脚本

```bash
dk-video script \
  --analysis analysis.json
```

输出结构化：

```json
{
  "title": "",
  "sections": [],
  "voiceover": [],
  "shots": []
}
```

重点是：

```text
结构化 Video Script
```

而不是单纯 Markdown。

---

# 22. 剪映 / DaVinci Draft

建议 Namespace：

```bash
dk-video draft capcut ...
dk-video draft davinci ...
```

内部统一先形成一个：

```text
DK Timeline IR
```

例如：

```json
{
  "timeline": {
    "fps": 25,
    "tracks": [],
    "clips": []
  }
}
```

再分别：

```text
DK Timeline
   │
   ├→ CapCut Adapter
   └→ DaVinci Adapter
```

不要：

```text
业务逻辑
→ 直接生成剪映 JSON

另一套业务逻辑
→ 直接生成 DaVinci
```

否则以后 Final Cut / Premiere 会重复实现。

---

# 23. 快速剪口播

```bash
dk-video talking-head clean input.mp4
```

负责：

```text
语音识别
↓
停顿检测
↓
重复表达识别
↓
删除建议
↓
Timeline
```

默认建议先：

```text
生成 Edit Decision
```

而不是直接 destructive render。

例如：

```json
{
  "cuts": [
    {
      "start": 12.1,
      "end": 14.7,
      "reason": "long_pause"
    }
  ]
}
```

再通过：

```bash
dk-video talking-head render ...
```

真正生成新视频。

---

# 24. `dk-image`

Namespace：

```text
content
generate
edit
organize
```

---

# 25. 图片内容分析

```bash
dk-image content score photo.jpg

dk-image content category photo.jpg

dk-image content describe photo.jpg

dk-image content filmstrip filmstrip.jpg

dk-image content keywords photo.jpg

dk-image content metadata photo.jpg

dk-image content ocr photo.jpg
```

---

## 摄影评分

输出不要只有：

```text
8.2
```

建议：

```json
{
  "overall": 8.2,
  "composition": 8.5,
  "lighting": 7.8,
  "subject": 8.1,
  "color": 8.4,
  "technical": 7.9
}
```

---

## 摄影题材

例如：

```text
Portrait
Street
Landscape
Food
Architecture
Product
Travel
Event
Documentary
Wildlife
```

---

## 胶片流描述

```bash
dk-image content filmstrip sheet.jpg
```

不同于普通图片：

> 要理解多个 Frame 的时间和内容关系。

---

# 26. 图片综合分析

```bash
dk-image analyze photo.jpg
```

组合：

```text
score
category
describe
keywords
metadata
ocr
```

---

# 27. 图片生成

```bash
dk-image generate \
  --prompt "..."
```

AI Provider 可以：

```text
API
Local
```

统一调用 AI Profile。

---

# 28. 水印

```bash
dk-image watermark image.jpg \
  --text "DKPLUS"
```

属于确定性功能，不需要 AI。

---

# 29. 文件夹分类

```bash
dk-image organize ./photos \
  --by category
```

或者：

```bash
dk-image organize ./photos \
  --by score \
  --threshold "excellent>=8"
```

这里虽然是 Batch Command，但属于典型“文件整理”能力，可以允许 CLI 自身 Batch。

输出必须有：

```text
dry-run
```

例如：

```bash
dk-image organize ./photos \
  --by category \
  --dry-run
```

先告诉用户：

```text
Landscape/
  32

Portrait/
  18

Food/
  41
```

确认后才移动。

---

# 30. AI Core 架构

核心抽象：

```ts
interface AIProvider {
  execute<TInput, TOutput>(
    task: AITask<TInput, TOutput>
  ): Promise<TOutput>
}
```

Provider：

```text
OpenAICompatibleProvider

LocalProcessProvider

LocalOpenAIProvider
```

未来：

```text
AzureOpenAIProvider
DashScopeProvider
AnthropicProvider
```

都可以加。

Command 不直接引用 Provider。

只引用：

```text
Feature
```

例如：

```text
audio.music.emotion
```

---

# 31. Local 模型策略

npm 包本身不要安装：

```text
PyTorch
Whisper 模型
CUDA Runtime
```

否则 npm 包会非常重。

Local 建议支持两种：

### Local API

例如：

```text
Ollama
LM Studio
vLLM
自己部署的服务
```

通过：

```text
OpenAI-compatible
```

调用。

### Local Process

例如：

```text
faster-whisper CLI
Python CLI
```

通过：

```text
spawn
```

执行。

所以：

```text
npm CLI
```

仍然可以调用：

```text
Python local model
```

而不会把 Python runtime 塞进 npm package。

---

# 32. Cache

AI 和媒体分析都建议统一支持：

```text
Input Hash
+
Command
+
Command Version
+
Config Hash
+
Model
```

生成 Cache Key。

例如：

```text
song hash
+
music.emotion
+
1.3.0
+
qwen3.5
+
prompt-v4
```

相同任务再次执行：

```text
cache hit
```

直接返回。

支持：

```bash
--no-cache
```

以及：

```bash
--force
```

---

# 33. Batch 原则

绝大多数 Command：

```text
默认 Single Item
```

例如：

```bash
dk-video filmstrip a.mp4
```

批量：

```text
交给 n8n / Node / Python
```

这样：

```text
并发
失败
重试
状态
取消
```

由 Orchestrator 负责。

例外：

```text
image organize
```

或者 GPU batch inference 等“批量本身就是能力”的 Command，可以内部 Batch。

---

# 34. 测试体系

要求：

> **每一个 Command 都必须有独立测试。**

推荐四层。

---

## Unit

例如：

```text
时间计算

Schema

参数解析

Hash

字幕格式转换

Timeline计算

分类规则
```

完全不依赖外部服务。

---

## Contract Test

每个 Command 必须测试：

```text
--help

--version

--json

success output

error output

exit code
```

确保 CLI Contract 永远稳定。

---

## Integration

例如：

```text
dk-video filmstrip
```

输入测试视频：

```text
fixtures/10-second.mp4
```

验证：

```text
manifest存在
图片存在
grid正确
timestamp正确
```

---

## AI Mock

默认测试：

```text
MockAIProvider
```

不要 CI 每次真的花 API 钱。

例如：

```text
music emotion
```

Mock 返回：

```json
{
  "primaryEmotion": "nostalgic"
}
```

检查：

```text
Schema
Command
Storage
Serialization
```

---

# 35. Live AI Test

单独提供：

```bash
pnpm test:live
```

只有设置：

```text
DKPLUS_LIVE_AI=1
```

才执行。

例如：

```bash
pnpm --filter @dkplus/dk-audio test:live
```

用于验证：

```text
真实百炼
真实 Azure
真实 Local Model
```

但不进入普通 PR 必过测试。

---

# 36. Fixtures

统一：

```text
packages/testing/fixtures/

audio/
  speech-short.wav
  conversation-two-speakers.wav
  music-short.wav

video/
  silent.mp4
  talking.mp4
  broll.mp4

image/
  portrait.jpg
  landscape.jpg
  text.jpg
  filmstrip.jpg
```

测试媒体尽量：

```text
3～15秒
```

避免 CI 很慢。

---

# 37. 每个 Command 的验收标准

任何新 Command 不满足下面条件不能 Merge：

```text
实现完成

Unit Test

Integration Test

Mock AI Test

CLI Contract Test

中文文档

英文文档

--help

JSON Schema

示例
```

也就是说：

> **代码不是功能完成的唯一标准。**

---

# 38. AI 可读文档

传统 README 不够。

推荐每个包发布：

```text
README.md
README.zh-CN.md

docs/
├── en/
│   └── ...
└── zh-CN/
    └── ...

commands.json
```

其中：

```text
commands.json
```

是机器可读 CLI Manifest。

例如：

```json
{
  "package": "@dkplus/dk-audio",
  "binary": "dk-audio",
  "commands": [
    {
      "command": "speech transcribe",
      "description": "Transcribe audio into subtitles",
      "input": {
        "type": "audio-file"
      },
      "outputs": [
        "json",
        "srt",
        "vtt"
      ]
    }
  ]
}
```

---

# 39. CLI 自己暴露 Schema

建议提供：

```bash
dk-audio describe --json
```

返回全部能力。

以及：

```bash
dk-audio speech transcribe --schema
```

输出：

```text
input schema
output schema
options
examples
```

这样 AI Agent 不需要爬 README。

可以直接：

```text
Agent
↓
dk-audio describe --json
↓
发现工具
↓
执行
```

这个能力对未来 Agent 化非常有价值。

---

# 40. 文档结构

每个 package：

```text
README.md
README.zh-CN.md

docs/
├── en/
│   ├── configuration.md
│   ├── ai-providers.md
│   ├── commands/
│   └── examples/
│
└── zh-CN/
    ├── configuration.md
    ├── ai-providers.md
    ├── commands/
    └── examples/
```

每个 Command 都必须有：

```text
作用

输入

输出

参数

AI要求

示例

JSON输出

错误码

测试方法
```

---

# 41. Demo App

建议：

```text
apps/media-demo
```

作用不是实现能力，而是：

> **真正作为 package 消费者安装 CLI。**

不要：

```text
import ../../packages/dk-video/src
```

应该：

```json
{
  "dependencies": {
    "@dkplus/dk-audio": "workspace:*",
    "@dkplus/dk-video": "workspace:*",
    "@dkplus/dk-image": "workspace:*"
  }
}
```

开发时 workspace link。

发布验证时：

```text
npm pack
↓
安装 tgz
↓
运行 Demo
```

从真正消费者角度验证 package 是否可用。

---

# 42. NPM Package 配置

例如：

```json
{
  "name": "@dkplus/dk-audio",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "dk-audio": "./dist/cli.js"
  },
  "files": [
    "dist",
    "README.md",
    "README.zh-CN.md",
    "docs",
    "commands.json"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

npm 对公开 scoped package 支持通过 `public` access 发布。

---

# 43. npm 发版：使用 Changesets

推荐：

```text
Changesets
+
GitHub Actions
+
npm Trusted Publishing
```

Changesets 本身就是针对多 package / monorepo 的版本、CHANGELOG 和发布工作流设计的，可以记录 semver bump 和 changelog，并发布版本高于 registry 当前版本的 package。

三个 CLI 独立版本：

```text
@dkplus/dk-audio
1.3.0

@dkplus/dk-video
2.1.0

@dkplus/dk-image
1.6.2
```

不要强制三个一起升版本。

---

# 44. 开发者工作流

修改：

```text
dk-audio music emotion
```

之后：

```bash
pnpm changeset
```

选择：

```text
@dkplus/dk-audio

minor
```

填写：

```text
Add cinematic music emotion analysis.
```

生成：

```text
.changeset/xxx.md
```

提交 PR。

---

# 45. PR CI

所有 PR：

```text
install
↓
lint
↓
typecheck
↓
unit tests
↓
integration tests
↓
build
↓
npm pack --dry-run
↓
demo smoke test
```

其中：

```text
npm pack --dry-run
```

特别重要。

它可以提前发现：

```text
dist没打进去

README没打进去

CLI bin不存在

不该发布的文件被打包
```

---

# 46. Release PR

Merge 到：

```text
main
```

之后 Changesets Action 自动维护：

```text
Version Packages
```

PR。

里面更新：

```text
package.json version

CHANGELOG.md

changeset
```

Changesets 官方 Action 支持这种 Version PR → Merge → Publish 的工作模式。

---

# 47. 正式发布

Merge Version PR：

```text
main
↓
Build
↓
Test
↓
Publish
```

只发布版本变化的 package。

例如：

```text
dk-audio
1.2.0 → 1.3.0

dk-video
没变化

dk-image
1.1.1 → 1.1.2
```

最终只发布：

```text
dk-audio
dk-image
```

---

# 48. 推荐 npm Trusted Publishing

当前 npm 已支持 GitHub Actions 通过 OIDC Trusted Publishing 发布 package，不需要长期保存 npm write token；采用 Trusted Publishing 时 npm 还会自动生成 package provenance。

因此推荐：

```text
GitHub Actions
     ↓
OIDC
     ↓
npm
```

而不是：

```text
GitHub Secrets
     ↓
永久 NPM_TOKEN
```

当前 npm 文档对 Trusted Publishing 的 GitHub Actions 流程要求 workflow 拥有：

```yaml
permissions:
  contents: write
  id-token: write
```

并在 npm package 设置中绑定对应仓库和 workflow。

这是正式生产发布优先方案。

---

# 49. Beta 发布

重大 Command 在正式发布前可以：

```text
beta
```

例如：

```text
@dkplus/dk-video@2.0.0-beta.1
```

Changesets 本身支持 prerelease workflow。

适用于：

```text
DaVinci Draft

CapCut Draft

Talking Head Auto Cut

大型 AI Analyze
```

因为这些 Contract 一旦正式发布后最好保持稳定。

---

# 50. SemVer 规则

必须统一：

### Patch

```text
bug fix

性能优化

Prompt优化且不改变Contract
```

例如：

```text
1.2.1
```

---

### Minor

```text
增加 Command

增加 Optional 字段

增加 Provider
```

例如：

```text
1.3.0
```

---

### Major

```text
删除 Command

修改 Command 参数

修改输出 Schema

改变已有语义
```

例如：

```text
2.0.0
```

对于 CLI，**JSON Contract 的变化也属于 API 变化**。

不能只考虑 TypeScript API。

---

# 51. 第一阶段核心功能

不建议第一版把所有列表功能一次全部做完。

建议先完成：

## `dk-audio`

```text
speech transcribe

speech translate

speech summarize

music metadata

music emotion

music analyze
```

---

## `dk-video`

```text
probe

audio

filmstrip

subtitles

content summary

content keywords

content highlights

analyze
```

---

## `dk-image`

```text
content metadata

content describe

content keywords

content ocr

content score

analyze

watermark
```

这批完成以后，整套：

```text
AI Provider

CLI Contract

JSON Schema

Test

Docs

Release
```

体系已经跑通。

---

# 52. 第二阶段

再增加：

### Audio

```text
speech emotion

music instruments

music structure

music texture

music trajectory

music narrative

music scenes
```

### Video

```text
content overlays

content usage

content narrative

script

talking-head clean
```

### Image

```text
content category

content filmstrip

generate

organize
```

---

# 53. 第三阶段

增加真正复杂的：

```text
CapCut Draft

DaVinci Timeline

自动粗剪

高级音乐推荐

视频与音乐匹配

Local GPU 服务
```

不要让这些能力拖慢第一版 CLI 基础设施。

---

# 54. 最终依赖关系

建议控制为：

```text
                   contracts
                       ↑
              ┌────────┼────────┐
              │        │        │
          cli-core   ai-core  media-core
              ↑        ↑        ↑
              └────────┼────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
       dk-audio     dk-image     dk-video
          ↑             ↑          ↑
          └─────────────┴──────────┘
                       │
                     apps
```

其中 `dk-video` 可以内部复用：

```text
dk-audio
dk-image
```

但要防止循环依赖。

建议依赖方向：

```text
audio
image
 ↑
 │
video
```

例如：

```text
video subtitles
↓
audio transcribe
```

---

# 55. 一个非常重要的内部原则

每个 Command 的实现应该分成：

```text
Core Function
     │
     ├── CLI Adapter
     ├── Node Library API
     └── Tests
```

例如：

```ts
createFilmstrip(...)
```

是核心能力。

然后：

```bash
dk-video filmstrip
```

只是：

```text
argv
↓
parse
↓
createFilmstrip()
↓
serialize
```

所以 Node 项目还可以直接：

```ts
import { createFilmstrip } from '@dkplus/dk-video'
```

而 Python、n8n 则：

```text
spawn dk-video
```

或走未来 Tool Runner。

这样才能做到真正高复用。

---

# 56. 最终设计原则

这套 monorepo 可以用下面几句话定下来：

> **一：npm Package 按领域分。**

```text
dk-audio
dk-video
dk-image
```

> **二：Command 按能力分。**

```text
audio music emotion
video filmstrip
image content ocr
```

> **三：Command 是原子能力。**

完整流程由：

```text
n8n
Node
Python
Agent
```

组合。

> **四：同时允许官方 Composite Command。**

例如：

```text
dk-audio music analyze
dk-video analyze
dk-image analyze
```

> **五：AI 模型通过 Feature → Profile 解耦。**

一条 CLI 内不同功能可以分别使用：

```text
Local Whisper
Fun-ASR
Qwen Omni
GPT
Local Vision
```

> **六：CLI Contract 统一。**

```text
JSON
JSONL
Exit Code
Schema
Errors
```

> **七：每一个 Command 必须有独立测试。**

不能只测综合 Analyze。

> **八：文档既给人看，也给 AI 看。**

```text
中文 README
英文 README
Command Docs
commands.json
--schema
describe --json
```

> **九：Apps 必须作为真正消费者使用 Package。**

不能直接依赖源码内部路径。

> **十：发布使用 Changesets + CI + npm Trusted Publishing。**

形成：

```text
Feature
↓
Tests
↓
Docs
↓
Changeset
↓
PR
↓
Version PR
↓
Merge
↓
npm Publish
```

这样第一阶段虽然只有三个 npm 包，但它实际上已经形成了一套比较完整的 **dkplus Media Capability Platform**。后面无论是 n8n 编排、Web 视频素材平台、音乐分析平台，还是 Codex/Agent 自动调用，都可以建立在同一套稳定 CLI Contract 上。
