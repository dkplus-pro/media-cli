# common-cli

通用 Node CLI 壳：给人用，也给 AI 用。本仓库不含具体业务功能，业务能力以**插件**形式接入（见 [插件开发指南](docs/plugin-development.md)）。

- 方案记录与架构决策：[docs/plans/00-master-plan.md](docs/plans/00-master-plan.md)
- 架构硬约束（协作者必读）：[AGENTS.md](AGENTS.md)
- 阶段执行文档：[docs/plans/01](docs/plans/01-repo-foundation.md) · [02](docs/plans/02-core-shell-and-contracts.md) · [03](docs/plans/03-plugin-system.md) · [04](docs/plans/04-introspection-and-example.md) · [05](docs/plans/05-testing-and-hardening.md)

## 快速开始

```bash
pnpm install
pnpm build
node dist/common-cli.js --help        # 人类友好帮助
node dist/common-cli.js --json spec   # AI 自省：完整命令树 JSON
node dist/common-cli.js --json hello --name AI   # 示例插件命令
```

## 人/AI 双契约（摘要）

- `--json`：stdout 有且只有一个 JSON 包络 `{ ok, data | error, warnings }`，可直接 `JSON.parse`
- stdout 只出数据，stderr 只出日志/警告；错误码 `E_*` 稳定，退出码成文
- 壳永不交互式提问，缺参数直接结构化报错——AI/脚本调用永不挂起

## 开发

```bash
pnpm dev -- --json version   # tsx 直跑源码
pnpm lint && pnpm test       # Biome + Vitest（e2e spawn dist 真进程）
```

技术底座：TypeScript + tsup（纯 ESM）· commander · pnpm · Biome · Vitest · Node >= 20。

## 内置插件

### media-av（本地音视频转化，依赖 ffmpeg/whisper.cpp）

```bash
node dist/common-cli.js --json media-filmstrip --input 视频.mp4 --output grid.jpg
#   4×4 十六格拼图，每格带时间戳——一张图让 AI 了解视频内容
node dist/common-cli.js --json media-to-audio --input 视频.mp4 --format m4a
node dist/common-cli.js --json media-transcribe --input 音频.mp3 --output out.srt   # 需 whisper.cpp
```

| 环境变量 | 说明 |
|---|---|
| `FFMPEG_PATH` / `FFPROBE_PATH` | 覆盖二进制（默认查 PATH；缺失报 `E_MISSING_DEPENDENCY` 带安装提示） |
| `WHISPER_CPP_BIN` | whisper.cpp 二进制（默认查 `whisper-cli`/`whisper-cpp`） |
| `WHISPER_MODEL` | ggml 模型路径（transcribe 必填，缺失报 `E_CONFIG`） |

依赖安装：`brew install ffmpeg`；whisper.cpp 用 `brew install whisper-cpp` 并下载 ggml 模型（base/small/medium）。ffmpeg 未编译 drawtext 时胶片图自动降级为无时间戳并附结构化警告。

### azure-image（Azure gpt-image-2 生图）

```bash
export AZURE_IMAGE_KEY_POOL="key1,key2"
export AZURE_IMAGE_ENDPOINT_POOL="https://res-a.cognitiveservices.azure.com,https://res-b.cognitiveservices.azure.com"
node dist/common-cli.js --json image-gen --prompt "一只红苹果" --output apple.png          # 纯文案
node dist/common-cli.js --json image-gen --prompt "改成水彩风" --ref apple.png --output wc.png   # 参考图（edits）
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AZURE_IMAGE_KEY_POOL` / `AZURE_IMAGE_ENDPOINT_POOL` | 必填 | 英文逗号分隔，**按索引一一配对**，长度不等报 `E_CONFIG` |
| `AZURE_IMAGE_DEPLOYMENT` | `gpt-image-2` | 部署名 |
| `AZURE_IMAGE_OUTPUT_FORMAT` | `png` | png/jpeg/webp |
| `AZURE_IMAGE_QUALITY` | `auto` | auto/low/medium/high |
| `AZURE_IMAGE_API_VERSION` | `2025-04-01-preview` | gpt-image-2 若要求更新版本，设此变量即可 |

调度策略：每次请求随机选一个账号发起，401/403/429/5xx 自动轮换下一账号重试，全池失败报 `E_PROVIDER_ERROR`；400 类参数错误不轮换。任何输出都不含 key。
