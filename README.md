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

### media-av（本地音视频转化与压缩，依赖 ffmpeg/whisper.cpp）

```bash
node dist/media-cli.js --json media-filmstrip --input 视频.mp4 --output grid.jpg
#   4×4 十六格拼图，每格带时间戳——一张图让 AI 了解视频内容
node dist/media-cli.js --json media-to-audio --input 视频.mp4 --format m4a
node dist/media-cli.js --json media-transcribe --input 音频.mp3 --output out.srt   # 需 whisper.cpp

# 压缩视频：H.264 CRF 26 重编码为 mp4（默认不改分辨率，faststart 利于网页播放）
node dist/media-cli.js --json media-compress-video --input 视频.mov                  # → 视频.min.mp4
node dist/media-cli.js --json media-compress-video --input 视频/ --recursive --max-height 720   # 文件夹批量 + 降分辨率
node dist/media-cli.js --json media-compress-video --input 视频.mp4 --codec hevc --crf 28       # 体积更小、编码更慢

# 压缩音频：有损格式保持原样重压（默认 128k）；wav/aiff 默认转无损 flac
node dist/media-cli.js --json media-compress-audio --input 录音.wav                  # → 录音.min.flac（无损缩小）
node dist/media-cli.js --json media-compress-audio --input song.mp3 --bitrate 96k   # → song.min.mp3
```

| 环境变量 | 说明 |
|---|---|
| `FFMPEG_PATH` / `FFPROBE_PATH` | 覆盖二进制（默认查 PATH；缺失报 `E_MISSING_DEPENDENCY` 带安装提示） |
| `WHISPER_CPP_BIN` | whisper.cpp 二进制（默认查 `whisper-cli`/`whisper-cpp`） |
| `WHISPER_MODEL` | ggml 模型路径（transcribe 必填，缺失报 `E_CONFIG`） |

依赖安装：`brew install ffmpeg`；whisper.cpp 用 `brew install whisper-cpp` 并下载 ggml 模型（base/small/medium）。ffmpeg 未编译 drawtext 时胶片图自动降级为无时间戳并附结构化警告。

### doubao（豆包多模态云端转写 + 音乐理解，依赖 ffmpeg + DOUBAO_API_KEY）

```bash
export DOUBAO_API_KEY="ARK 控制台创建的 key"
export DOUBAO_TRANSCRIBE_MODEL="doubao-seed-2-0-mini-260428"   # 模型 id 不内置默认值，换型号只改这里
node dist/media-cli.js --json doubao-media-transcribe --input 访谈.mp4                 # → 访谈.mp4.srt
node dist/media-cli.js --json doubao-media-transcribe --input 会议.wav --format txt    # 纯文本，无时间轴
node dist/media-cli.js --json doubao-media-transcribe --input 课程.mp3 \
  --prompt "术语：张量、反向传播" --language zh                                          # 专名/语言提示
node dist/media-cli.js --json doubao-media-transcribe --input 课程.mp3 --model doubao-seed-2-0-pro-260428   # 临时换型号
```

音乐理解分析（`doubao-music-analysis`）——听懂一段音乐并输出 JSON 描述：风格、情感、BPM/调性、乐器、分段结构（每段时间/情感/强度）、视频适用场景与剪辑建议、记忆点：

```bash
node dist/media-cli.js --json doubao-music-analysis --input BGM.mp3                   # → BGM.music.json
node dist/media-cli.js --json doubao-music-analysis --input 素材mv.mp4                # 视频同样可喂（取音轨）
node dist/media-cli.js --json doubao-music-analysis --input 音乐库/ --recursive       # 文件夹批量 → ./music-analysis/
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DOUBAO_API_KEY` | 必填 | 缺失报 `E_CONFIG`；无效（401/403）同样报 `E_CONFIG` |
| `DOUBAO_TRANSCRIBE_MODEL` | 必填（或每次传 `--model`） | 需 `input_modalities` 含 `audio` 的型号；两者都缺报 `E_CONFIG` 且不发起请求 |
| `DOUBAO_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | Ark OpenAI 兼容端点（注意 `/api/compatible` 路径不存在） |
| `DOUBAO_TIMEOUT_MS` | `120000` | 单次片段请求超时 |

与 `media-transcribe`（本地 whisper.cpp）的分工：豆包不用下载模型、中文与嘈杂音频更稳，但模型不返回逐句时间戳——长音频由 silencedetect 按静音切段（默认 30s/段、4 并发）后逐段转写，**段边界精确、段内各行按字数比例估算**，输出附 `E_TIMELINE_APPROXIMATE` 警告；需要逐句精确时间轴请用 `media-transcribe`。

`doubao-music-analysis` 与转写共用上表环境变量；分析是推理密集型（比转写慢，45s 音乐约 50s、6 分钟约 2–3 分钟），≤240s 整曲单请求、更长曲子自动切段（默认 120s/段）并发分析后合并成全局一致的描述；模型时间戳为估算，structure 未覆盖到结尾或输入疑似非音乐时会附警告（不失败）。

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

### modelscope-image（ModelScope API-Inference 生图，Qwen-Image 系列）

```bash
# ~/.zshrc
export MODELSCOPE_BASE_URL="https://api-inference.modelscope.cn"   # ModelScope token 对应域名；.ai 国际站同理
export MODELSCOPE_API_KEY="ms-xxxxxxxx"                            # ModelScope 个人中心 → 访问令牌
export MODELSCOPE_IMAGE_MODEL="Qwen/Qwen-Image-2.1"                # 默认模型名，--model 可覆盖
node dist/media-cli.js --json modelscope-image-gen --prompt "一只红苹果" --output apple.png
node dist/media-cli.js --json modelscope-image-gen --prompt "江南水乡" --size 1328x1328 --steps 40 --guidance 3.5 --seed 12345
node dist/media-cli.js --json modelscope-image-gen --prompt "赛博城市" --negative-prompt "模糊, 低画质"
node dist/media-cli.js --json modelscope-image-gen --prompt "把背景换成海边日落" --ref "$(node dist/media-cli.js --json tencent-cos-upload --file a.png | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MODELSCOPE_API_KEY` | 必填 | Bearer token；缺失报 `E_CONFIG` 且不发请求 |
| `MODELSCOPE_IMAGE_MODEL` | 必填（或每次传 `--model`） | 模型 id，如 `Qwen/Qwen-Image-2.1`；可调用清单见 [AIGC 专区模型库](https://www.modelscope.cn/aigc/models) |
| `MODELSCOPE_BASE_URL` | `https://api-inference.modelscope.cn` | 网关根地址（不含 `/v1`，误填 `/v1` 会被自动剥掉） |
| `MODELSCOPE_TIMEOUT_MS` | `300000` | 单次 HTTP 与整体轮询的超时上限 |
| `MODELSCOPE_POLL_INTERVAL_MS` | `2000` | 异步任务轮询间隔 |

契约依据 [ModelScope API-Inference 官方文档](https://www.modelscope.cn/docs/model-service/API-Inference/intro) 的 AIGC 生图参数表：`model`/`prompt` 必填，`size` 是 **`"WxH"` 字符串**（不是 `width`/`height`；`"928*1664"` 会被网关拒：`size format should be WxH`），`steps` [1,100]、`guidance` [1.5,20]、`seed` [0,2^31-1]、`negative_prompt`、`image_url`（编辑类模型）、`loras`。分辨率档位按系列不同，**Qwen-Image 为 [64x64, 1664x1664]**。

`--ref <url>` 透传 `image_url` 走图生图/编辑：Qwen-Image-2.1 官方卡片把它定义为「unified text-to-image generation and image editing」，本地管线用 `pipe(image=...)`，网关侧对应 `image_url`。**只接受公网 http(s) URL**（本地路径不做隐式上传，先跑 `tencent-cos-upload` 换 URL），结果契约不变：`data.refUrl` 回显参考图地址。

实测（2026-10-14）：`--ref` 生效——上传到 COS 的白底红苹果图，配 prompt「改成蓝色透明玻璃材质，保持构图与光照」后，输出的果柄朝向、苹果位置、背景与光照与参考图一致，只有材质被替换；未传 `--ref` 时同域名走的是纯文生图。注意结果对象的 `sourceUrl` 路径仍写作 `aigc/text-to-image/...`，不要据此判断编辑没生效。

链路：`POST {base}/v1/images/generations`（带 `X-ModelScope-Async-Mode: true`）→ 拿 `task_id` → 轮询 `GET {base}/v1/tasks/{id}`（带 `X-ModelScope-Task-Type: image_generation`）→ `task_status` 为 `SUCCEED` 时取 `output_images[0]` 下载（下载**不携带 apikey**），`FAILED` 报 `E_PROVIDER_ERROR` 并带 `details.taskId`。也兼容 OpenAI 同步形态 `{ data: [{ b64_json | url }] }`。**实测坑位**：提交响应会提前回 `task_status: "SUCCEED"` 而任务其实还在跑，因此只要响应里没有图片且有 `task_id` 就一律以轮询结果为准。`data.size` 报的是**真实解码像素**（不是请求值），二者不一致时附 `E_SIZE_MISMATCH` 警告。

### tencent-cos（腾讯云 COS 文件上传，换公网 URL）

```bash
# ~/.zshrc —— 两个池：prod 与 test，各有一套桶/前缀/域名
export TENCENT_SECRET_ID="AKIDxxxxxxxx"        # 腾讯云 API 密钥（SecretId）
export TENCENT_SECRET_KEY="xxxxxxxx"           # 腾讯云 API 密钥（SecretKey）
export COS_REGION="ap-guangzhou"
export COS_ENV="prod"                          # 默认池，--env 可覆盖（无内置默认值）
export COS_PROD_BUCKET="prod-<APPID>"          # 必须含 -APPID 后缀
export COS_PROD_PREFIX="tmp/"
export CDN_PURGE_URL_PROD="https://cdn.ai4love.cn/tmp/dist/index.html"
export COS_TEST_BUCKET="dev-<APPID>"
export COS_TEST_PREFIX="tmp/"
export CDN_PURGE_URL_TEST="https://devcdn.ai4love.cn/tmp/dist/index.html"

node dist/media-cli.js --json tencent-cos-upload --file a.png
node dist/media-cli.js --json tencent-cos-upload --file 设计稿.pdf --env test --key docs/design.pdf
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 必填 | 腾讯云 API 密钥对；缺失报 `E_CONFIG` 且不发请求 |
| `COS_REGION` | 必填 | 桶所在地域，如 `ap-guangzhou` |
| `COS_ENV` | 必填（或每次传 `--env`） | 默认池 `prod` \| `test`；工具不替用户选默认池 |
| `COS_<ENV>_BUCKET` | 必填 | 桶名，必须带 `-APPID` 后缀 |
| `COS_<ENV>_PREFIX` | 空（根目录） | 对象 key 前缀；不允许以 `/` 开头，末尾斜杠自动归一 |
| `CDN_PURGE_URL_<ENV>` | 必填 | 该环境的文件生命周期接口地址，本工具**只取它的 origin 作公网访问域名**，不发任何 purge 请求 |
| `TENCENT_COS_DOMAIN` | 未设 | 自测/代理场景把 SDK 请求指向指定 host（如本地 mock） |
| `TENCENT_COS_TIMEOUT_MS` | `120000` | 单次上传超时上限 |

上传单个文件（`--file`，目录/不存在分别报 `E_INVALID_OPTION` / `E_MISSING_ARGUMENT`），对象默认永久保留（不写过期元数据、不驻留计时）。默认对象名 = `<前缀><文件名 ASCII slug>-<ISO 时间戳>[.<扩展名>]`——非 ASCII 字符折叠为 `-`，因为对象 key 会直接进公网 URL 而不做二次编码；`--key` 可指定（同样限定 `[A-Za-z0-9._-]` 与 `/`，拒绝绝对路径与 `..`，并自动带上前缀）。`data.url` = 池域名 origin + `/` + key，另回显 `key`/`bucket`/`region`/`env`/`bytes`/`contentType`/`etag`。COS 侧失败报 `E_PROVIDER_ERROR` 且 `details.source=tencent-cos`（带 `status`/`code`/`bucket`/`key`）；超时同样 `E_PROVIDER_ERROR` 并附 `hint`——请求可能已到达 COS，重传前先确认该 key。

### media-cutout（本地抠图，macOS 14+）

```bash
node dist/media-cli.js --json media-cutout --input photo.jpg --output cut.png      # 单文件：透明 PNG，裁剪到主体+32px 边距
node dist/media-cli.js --json media-cutout --input 图册/ --output cutout/           # 文件夹批量（一级）
node dist/media-cli.js --json media-cutout --input 图册/ --recursive                # 递归子目录，输出 mirror 目录结构
node dist/media-cli.js --json media-cutout --input photo.jpg --no-crop              # 不裁剪，保留原始画布
```

引擎为 Apple Vision framework（与系统「拷贝主体」同款分割，ANE 加速单张约 0.2s）。首次运行用 `swiftc` 自动编译工具并缓存到 `~/.media-cli/cache/media-cutout/`（源码变更自动重编译；`CUTOUT_BIN` 可指向现成二进制跳过编译）。仅支持 macOS 14+，其他平台报 `E_MISSING_DEPENDENCY`。支持 jpg/jpeg/png/webp；文件夹批量时单张失败不影响其余（失败项记入 `data.failed`）。

### media-image（图片压缩 / 文字水印 / 合并 PDF，基于 sharp + pdf-lib，无外部依赖）

```bash
# 压缩体积：不改变分辨率、不转格式；默认旁路输出不覆盖原图
node dist/media-cli.js --json media-compress --input photo.jpg                       # 单文件 → photo.min.jpg
node dist/media-cli.js --json media-compress --input 图册/ --output min/ --quality 80 # 文件夹批量（--recursive 递归子目录）

# 平铺斜角文字水印：默认 30°、透明度 0.3、间距 80px，字体/字号/颜色可调
node dist/media-cli.js --json media-watermark --input photo.jpg --text "版权所有" --font "PingFang SC"
node dist/media-cli.js --json media-watermark --input 图册/ --text "DO NOT COPY" --angle 30 --spacing 80 --opacity 0.3 --recursive

# 合并 PDF：整个目录合成一个多页 PDF，页面顺序默认按文件名自然序（p2 在 p10 前）
node dist/media-cli.js --json media-to-pdf --input photo.jpg                          # 单文件 → photo.pdf（一页）
node dist/media-cli.js --json media-to-pdf --input 扫描件/                            # → ./扫描件.pdf，逐张一页
node dist/media-cli.js --json media-to-pdf --input 图册/ --output 相册.pdf --page a4 --margin 24 --quality 80
```

支持 jpg/jpeg/png/webp；文件夹批量时单张失败不影响其余（失败项记入 `data.failed`）。压缩结果不比原图小时跳过落盘（`skipped: true`），原图永不变大；PNG 为无损优化（不量化），要明显减体积请压 jpg/webp。带 EXIF 方向的图会先摆正到像素再处理。水印文字经 SVG 渲染（sharp 内置，无需 fontconfig 配置），字体由系统字体库解析，缺失时回退默认字体；输出重编码用高画质（jpeg 92 / webp 90 / png 无损）。

`media-to-pdf` 与其他批量命令语义不同：一个目录出**一个** PDF（不是逐张产物），默认每页贴合该图尺寸（像素按 `--dpi` 换算，默认 300dpi），也可用 `--page a4|letter` + `--margin` 固定纸张、`--orientation auto` 让横图自动出横页。页内图片默认重编码为 jpeg（透明区域压白底），`--image-format png` 可保留 alpha。**默认任一张图解码失败即整体报 `E_PROVIDER_ERROR` 且不写出半成品 PDF**，确认能丢页时加 `--skip-broken`（跳过项计入 `data.skipped`，并附 `E_PARTIAL_INPUT` 警告）。

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
