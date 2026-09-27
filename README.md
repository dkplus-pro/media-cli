# media-cli

通用 Node CLI 壳：给人用，也给 AI 用。本仓库不含具体业务功能，业务能力以**插件**形式接入（见 [插件开发指南](docs/plugin-development.md)）。

- 方案记录与架构决策：[docs/plans/00-master-plan.md](docs/plans/00-master-plan.md)
- 架构硬约束（协作者必读）：[AGENTS.md](AGENTS.md)
- 阶段执行文档：[docs/plans/01](docs/plans/01-repo-foundation.md) · [02](docs/plans/02-core-shell-and-contracts.md) · [03](docs/plans/03-plugin-system.md) · [04](docs/plans/04-introspection-and-example.md) · [05](docs/plans/05-testing-and-hardening.md)

## 快速开始

```bash
npm i -g @dkplus/media-cli    # 全局安装（自带全部内置插件）
media-cli --help
media-cli --json spec        # AI 自省：完整命令树 JSON
```

本地开发：

```bash
pnpm install
pnpm build
node dist/media-cli.js --help        # 人类友好帮助
node dist/media-cli.js --json spec   # AI 自省：完整命令树 JSON
node dist/media-cli.js --json hello --name AI   # 示例插件命令
```

插件发现优先级：`MEDIA_CLI_PLUGINS_DIR` > 项目 `./plugins/` > 全局 `~/.media-cli/plugins/` > **随包内置**（同名先到先得，可用同名插件覆盖内置版本）。

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
node dist/media-cli.js --json media-filmstrip --input 视频.mp4 --output grid.jpg
#   4×4 十六格拼图，每格带时间戳——一张图让 AI 了解视频内容
node dist/media-cli.js --json media-to-audio --input 视频.mp4 --format m4a
node dist/media-cli.js --json media-transcribe --input 音频.mp3 --output out.srt   # 需 whisper.cpp
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
node dist/media-cli.js --json image-gen --prompt "一只红苹果" --output apple.png          # 纯文案
node dist/media-cli.js --json image-gen --prompt "改成水彩风" --ref apple.png --output wc.png   # 参考图（edits）
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AZURE_IMAGE_KEY_POOL` / `AZURE_IMAGE_ENDPOINT_POOL` | 必填 | 英文逗号分隔，**按索引一一配对**，长度不等报 `E_CONFIG` |
| `AZURE_IMAGE_DEPLOYMENT` | `gpt-image-2` | 部署名 |
| `AZURE_IMAGE_OUTPUT_FORMAT` | `png` | png/jpeg/webp |
| `AZURE_IMAGE_QUALITY` | `auto` | auto/low/medium/high |
| `AZURE_IMAGE_API_VERSION` | `2025-04-01-preview` | gpt-image-2 若要求更新版本，设此变量即可 |

调度策略：每次请求随机选一个账号发起，401/403/429/5xx 自动轮换下一账号重试，全池失败报 `E_PROVIDER_ERROR`；400 类参数错误不轮换。任何输出都不含 key。

### media-cutout（本地抠图，macOS 14+）

```bash
node dist/media-cli.js --json media-cutout --input photo.jpg --output cut.png      # 单文件：透明 PNG，裁剪到主体+32px 边距
node dist/media-cli.js --json media-cutout --input 图册/ --output cutout/           # 文件夹批量（一级）
node dist/media-cli.js --json media-cutout --input 图册/ --recursive                # 递归子目录，输出 mirror 目录结构
node dist/media-cli.js --json media-cutout --input photo.jpg --no-crop              # 不裁剪，保留原始画布
```

引擎为 Apple Vision framework（与系统「拷贝主体」同款分割，ANE 加速单张约 0.2s）。首次运行用 `swiftc` 自动编译工具并缓存到 `~/.media-cli/cache/media-cutout/`（源码变更自动重编译；`CUTOUT_BIN` 可指向现成二进制跳过编译）。仅支持 macOS 14+，其他平台报 `E_MISSING_DEPENDENCY`。支持 jpg/jpeg/png/webp；文件夹批量时单张失败不影响其余（失败项记入 `data.failed`）。

### media-image（图片压缩 / 文字水印，基于 sharp，无外部依赖）

```bash
# 压缩体积：不改变分辨率、不转格式；默认旁路输出不覆盖原图
node dist/media-cli.js --json media-compress --input photo.jpg                       # 单文件 → photo.min.jpg
node dist/media-cli.js --json media-compress --input 图册/ --output min/ --quality 80 # 文件夹批量（--recursive 递归子目录）

# 平铺斜角文字水印：默认 30°、透明度 0.3、间距 80px，字体/字号/颜色可调
node dist/media-cli.js --json media-watermark --input photo.jpg --text "版权所有" --font "PingFang SC"
node dist/media-cli.js --json media-watermark --input 图册/ --text "DO NOT COPY" --angle 30 --spacing 80 --opacity 0.3 --recursive
```

支持 jpg/jpeg/png/webp；文件夹批量时单张失败不影响其余（失败项记入 `data.failed`）。压缩结果不比原图小时跳过落盘（`skipped: true`），原图永不变大；PNG 为无损优化（不量化），要明显减体积请压 jpg/webp。带 EXIF 方向的图会先摆正到像素再处理。水印文字经 SVG 渲染（sharp 内置，无需 fontconfig 配置），字体由系统字体库解析，缺失时回退默认字体；输出重编码用高画质（jpeg 92 / webp 90 / png 无损）。

### suno-music（文生音乐 / 文生音效，open.suno.cn）

```bash
export SUNO_API_KEY="你的密钥"
node dist/media-cli.js --json suno-gen --prompt "lo-fi hip hop" --output song.mp3    # 灵感模式（每次生成 2 首，落盘为 song-1/-2.mp3）
node dist/media-cli.js --json suno-gen --lyrics "歌词..." --tags "pop" --instrumental  # 自定义歌词模式
node dist/media-cli.js --json suno-sound --text "雷雨声" --loop --output rain.mp3     # 文生音效
node dist/media-cli.js --json suno-gen --prompt "..." --no-wait                       # 只提交，返回 taskIds
node dist/media-cli.js --json suno-task --id 204 && node dist/media-cli.js --json suno-download --id 204 --output s.mp3
node dist/media-cli.js --json suno-balance                                            # 查积分
```

默认阻塞轮询至完成并自动下载（`SUNO_TIMEOUT_MS` 默认 600000，超时的 `details.taskIds` 可用 `suno-download` 恢复，不浪费已扣积分）。音频链接限时 1 小时，完成即下载。`suno-gen` 模型默认 `chirp-hawk`；`suno-sound` 模型可选 `chirp-crow`/`chirp-fenix`。`SUNO_BASE_URL` 可指向本地 mock（e2e 即此方式）。
