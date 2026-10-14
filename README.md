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

### doubao（豆包多模态云端转写 + 音乐理解 + 宫格定位，依赖 ffmpeg + DOUBAO_API_KEY）

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

视觉模型定位宫格分镜（`doubao-grid-locate`）——给整页九宫格/漫画分镜输出**每格的像素矩形**，产物 cells JSON 可直接喂 `media-grid-caption --cells`（见下文 media-image 段）：

```bash
export DOUBAO_VISION_MODEL="doubao-seed-2-1-lite-260915"   # 视觉型号同样不内置默认值，换型号只改这里
node dist/media-cli.js --json doubao-grid-locate --input 分镜页.png --output cells.json   # 落盘，人工核对后再用
node dist/media-cli.js --json doubao-grid-locate --input 分镜页.png --expected 9          # 提示应有格数（仅告警不失败）
node dist/media-cli.js --json doubao-grid-locate --input 分镜页.png --max-side 1024       # 送模型前压到长边 1024 以内
node dist/media-cli.js --json doubao-grid-locate --input 大页.png --timeout 360000        # 慢页放宽单次超时（默认 300000）
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DOUBAO_API_KEY` | 必填 | 缺失报 `E_CONFIG`；无效（401/403）同样报 `E_CONFIG` |
| `DOUBAO_TRANSCRIBE_MODEL` | 必填（或每次传 `--model`） | 需 `input_modalities` 含 `audio` 的型号；两者都缺报 `E_CONFIG` 且不发起请求 |
| `DOUBAO_VISION_MODEL` | 必填（或每次传 `--model`） | `doubao-grid-locate` 用的视觉型号，**不内置默认值**（豆包型号按月更新）；两者都缺报 `E_CONFIG`（`details.var="DOUBAO_VISION_MODEL"`）且不发请求 |
| `DOUBAO_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | Ark OpenAI 兼容端点（注意 `/api/compatible` 路径不存在） |
| `DOUBAO_TIMEOUT_MS` | `120000` | 单次请求超时（转写的片段请求走它）。**`doubao-grid-locate` 例外**：本命令自带默认 `300000`（实测视觉单页 181.8s/329.6s，120s 会把正常的慢响应判成超时）；优先级 `--timeout` > `DOUBAO_TIMEOUT_MS` > 命令默认 |

与 `media-transcribe`（本地 whisper.cpp）的分工：豆包不用下载模型、中文与嘈杂音频更稳，但模型不返回逐句时间戳——长音频由 silencedetect 按静音切段（默认 30s/段、4 并发）后逐段转写，**段边界精确、段内各行按字数比例估算**，输出附 `E_TIMELINE_APPROXIMATE` 警告；需要逐句精确时间轴请用 `media-transcribe`。

`doubao-music-analysis` 与转写共用上表环境变量；分析是推理密集型（比转写慢，45s 音乐约 50s、6 分钟约 2–3 分钟），≤240s 整曲单请求、更长曲子自动切段（默认 120s/段）并发分析后合并成全局一致的描述；模型时间戳为估算，structure 未覆盖到结尾或输入疑似非音乐时会附警告（不失败）。

`doubao-grid-locate` 与上面两条命令共用同一组 doubao 环境变量，但**不需要 ffmpeg**（只读静态图，图片以 `data:image/…;base64` 内联）。它的 `data` 就是 `media-grid-caption --cells` 的输入（统一 schema：`cells[].index/x/y/w/h` 为**原图像素、左上原点** + `image.width/height` + `source`/`model`），中间零转换，可 `--output` 落盘、人工改完再用。

送模型前会把长边缩到 `--max-side`（默认 1568，范围 256–4096）以内，并**统一重编码为 JPEG q82**（真实 2048x2048 RGBA 分镜页实测：原图直送 data URI 8,737,762 字符 → 1568+PNG 无损 7,935,070（只瘦 9.2%）→ 1568+JPEG **397,995** 字符，瘦 95.4%；透明区压白底并在 `data.notes` 里说明，`data.sent.encode` 记录实际编码）。**返回坐标一律换算回原图像素**，`data.scale` 与 `data.sent` 把这次缩放留在可审计的位置。

⚠️ **瘦身不降耗时，别把它当稳定性方案**：同一页 `--max-side 512`（请求体再瘦 89.5%）与默认 1568 一样在 3 次 × 120s 后全部 `E_PROVIDER_ERROR / reason:"timeout"`（累计 362.7s）。**视觉耗时是 provider 侧的**，与请求体大小无关。

实测（2026-10-14 起的两轮，同一张 2048x2048 真实 3x3 分镜页，面板带倾斜、格边界互相错开）：降采样改动**没有让单页变快，反而更慢**——S019 由 239s 变 **329.6s**、S017 由 88s 变 **181.8s**。所以本命令的超时默认提到 **300000ms**（`--timeout` 可再覆盖）：300s 兜得住 181.8s 那次，兜不住 329.6s 那次（靠 `chatWithRetry` 的第二次尝试接住），**要一次性兜住慢页请传 `--timeout 360000`**。耗时以分钟计，跑大页前要有等待的心理准备。

另外两件事必须知道：
1. **框每次都要肉眼核对**。两轮实测里一页返回 9 个位置正确的框，另一页只返回 **7** 个——模型把相邻两格**合并成一格**，于是一句台词被静默丢掉；返回 9 格的那页还出现过两格重叠 628x24px。`--expected 9` 只能让「检出数与提示数不符」附 `E_CELL_COUNT_MISMATCH` 警告，不会失败，也不保证每格都对。
2. **格子可能带重叠**。坐标来自缩小图、放大回原图时必然取整，相邻格的公共边会错开几像素。产出侧已把「薄边 ≤5%」的重叠在重叠区内切齐（`data.overlapRepaired` 计数 + `E_CELL_OVERLAP_REPAIRED` 警告），剩下的交大重叠交给消费侧按 `--max-overlap`（默认 0.05）分级：小重叠 `E_CELLS_OVERLAP` 警告 + 照常渲染 + exit 0，大重叠才 `E_INVALID_OPTION`（exit 2），确认是刻意的分层版式用 `--allow-overlap` 全放行。

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
export MODELSCOPE_KEY_POOL="ms-aaaa,ms-bbbb"                       # 可选：多 token 池（逗号分隔），覆盖上面的单 key
export MODELSCOPE_IMAGE_MODEL="Qwen/Qwen-Image-2.1"                # 默认模型名，--model 可覆盖
export MODELSCOPE_FAST_MODEL="Qwen/Qwen-Image-2.1-Turbo"           # 可选：modelscope-image-fast 的默认模型（不配也用这个内置值）
node dist/media-cli.js --json modelscope-image-gen --prompt "一只红苹果" --output apple.png
node dist/media-cli.js --json modelscope-image-gen --prompt "江南水乡" --size 1328x1328 --steps 40 --guidance 3.5 --seed 12345
node dist/media-cli.js --json modelscope-image-gen --prompt "赛博城市" --negative-prompt "模糊, 低画质"
node dist/media-cli.js --json modelscope-image-gen --prompt "把背景换成海边日落" --ref "$(node dist/media-cli.js --json tencent-cos-upload --file a.png | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
# 多图参考：--ref 后面直接跟多个 URL（上限 10 张）
node dist/media-cli.js --json modelscope-image-gen --prompt "把两个水果并排放在白桌面上，保持各自细节" \
  --ref https://cdn.example.com/tmp/apple.png https://cdn.example.com/tmp/watermelon.png --output two.png
# 按比例出图（映射到网关可用的最大档，与 --size 二选一）
node dist/media-cli.js --json modelscope-image-gen --prompt "全景山景" --ratio 16:9

# 快速档 modelscope-image-fast：默认即 Turbo + steps=8 + guidance=1 + 2048x2048（实测端到端 37.1s）
node dist/media-cli.js --json modelscope-image-fast --prompt "一只红苹果" --output apple.png
node dist/media-cli.js --json modelscope-image-fast --prompt "赛博城市" --ratio 16:9 --seed 12345
node dist/media-cli.js --json modelscope-image-fast --prompt "把背景换成海边日落" --ref https://cdn.example.com/tmp/a.png
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MODELSCOPE_API_KEY` | 必填（或设 `MODELSCOPE_KEY_POOL`） | Bearer token；两者都缺失报 `E_CONFIG` 且不发请求 |
| `MODELSCOPE_KEY_POOL` | 未设则用单 key | 逗号分隔的多个 token（自动 trim），设置后覆盖 `MODELSCOPE_API_KEY` |
| `MODELSCOPE_IMAGE_MODEL` | 必填（或每次传 `--model`） | 模型 id，如 `Qwen/Qwen-Image-2.1`；可调用清单见 [AIGC 专区模型库](https://www.modelscope.cn/aigc/models) |
| `MODELSCOPE_FAST_MODEL` | `Qwen/Qwen-Image-2.1-Turbo` | **`modelscope-image-fast` 专用**，有内置默认值（不配也能跑），`--model` 可覆盖；其余 key/池/域名/超时变量与 `modelscope-image-gen` 完全共用 |
| `MODELSCOPE_BASE_URL` | `https://api-inference.modelscope.cn` | 网关根地址（不含 `/v1`，误填 `/v1` 会被自动剥掉） |
| `MODELSCOPE_TIMEOUT_MS` | `300000` | 单次 HTTP 与整体轮询的超时上限 |
| `MODELSCOPE_POLL_INTERVAL_MS` | `2000` | 异步任务轮询间隔 |

多 key 池的调度策略：提交的起点 key 随机（多进程并发时天然分摊），401/403/429/5xx/网络错误换下一把重试，全池失败报 `E_PROVIDER_ERROR` 并带逐把 `details.attempts`；400 类参数错误不轮换（换账号无意义）。**异步任务只属于提交它的那个账号，所以轮询与状态查询固定沿用成功的那把 key**；轮询期撞 429 不判失败，用同一把 key 续等（否则一次已付费的生成会被限流作废）。`data.keyIndex` 回显本次消耗的是池里第几把 key（只回下标，任何输出都不含 key 原文）。

> 为什么需要池：实测网关对 `Qwen/Qwen-Image-2.1` 按 key 计**单并发**——已有任务在跑时同 key 再提交直接 429（`We have to rate limit you for model Qwen/Qwen-Image-2.1`）。单靠一把 key 无法并行出图。

契约依据 [ModelScope API-Inference 官方文档](https://www.modelscope.cn/docs/model-service/API-Inference/intro) 的 AIGC 生图参数表：`model`/`prompt` 必填，`size` 是 **`"WxH"` 字符串**（不是 `width`/`height`；`"928*1664"` 会被网关拒：`size format should be WxH`），`steps` [1,100]、`guidance` [1,20]（下限原写 1.5，因 Turbo 官方 CFG=1 已放宽到 1）、`seed` [0,2^31-1]、`negative_prompt`、`image_url`（编辑类模型，字符串或 URL 数组）、`loras`。其中 `steps` 文档写 [1,100]，但**该模型网关实际只收到 [1,50]**（提交期 400：`steps must be in [1,50]`）——上限随模型而变，所以本地按文档的宽区间放行，越界交给网关原文报错。

**尺寸上限以实测为准**：文档表写 Qwen-Image 档位 `[64x64, 1664x1664]`，但网关实际按**每边 `[64, 2048]`** 校验（超界在提交期直接 400：`width must be integer in [64,2048]`，不消耗出图额度），`2048x2048` 实测真出 2048×2048。注意 [Qwen-Image-2.1 仓库](https://github.com/QwenLM/Qwen-Image-2.1) 推荐的 `2400/2528/2752` 长边是**本地 diffusers 管线**的档位，经网关会被拒。

`--ratio` 把官方 7 个比例映射到网关可用的最大档（比例精确、每边 ≤2048、均为 16 的倍数），与 `--size` 二选一：

| `--ratio` | 实际 `size` | | `--ratio` | 实际 `size` |
|---|---|---|---|---|
| `1:1` | `2048x2048` | | `2:3` | `1344x2016` |
| `4:3` | `2048x1536` | | `16:9` | `2048x1152` |
| `3:4` | `1536x2048` | | `9:16` | `1152x2048` |
| `3:2` | `2016x1344` | | | |

实测（2026-10-14）：`--ratio 16:9` 经 CLI 出真 2048×1152、无 `E_SIZE_MISMATCH` 警告。

`--ref <urls...>` 透传 `image_url` 走图生图/多图参考编辑：Qwen-Image-2.1 官方卡片把它定义为「unified text-to-image generation and image editing」，并标明**单次最多 10 张参考图**。**只接受公网 http(s) URL**（本地路径不做隐式上传，先跑 `tencent-cos-upload` 换 URL）。一张时传字符串、多张时传数组（两种形态都实测生效），结果 `data.refUrls` 按传入顺序回显。

实测（2026-10-14）：单图 `--ref` 生效——上传到 COS 的白底红苹果图，配 prompt「改成蓝色透明玻璃材质，保持构图与光照」后，输出的果柄朝向、苹果位置、背景与光照与参考图一致，只有材质被替换。多图 `--ref a b` 同样生效——用两张带**独有特征**的参考图（黄苹果+黑色五角星、紫肉+方形籽西瓜）做判据，出图两处特征同时复现，说明两张图都被消费，而非只取第一张。注意结果对象的 `sourceUrl` 路径仍写作 `aigc/text-to-image/...`，不要据此判断编辑没生效。

链路：`POST {base}/v1/images/generations`（带 `X-ModelScope-Async-Mode: true`）→ 拿 `task_id` → 轮询 `GET {base}/v1/tasks/{id}`（带 `X-ModelScope-Task-Type: image_generation`）→ `task_status` 为 `SUCCEED` 时取 `output_images[0]` 下载（下载**不携带 apikey**），`FAILED` 报 `E_PROVIDER_ERROR` 并带 `details.taskId`。失败原因一律摊进人话：网关的错误载荷可能是 `message` 字符串、`errors:{message,request_id}` 对象或 `errors[]` 数组，插件按 `message/msg/detail/error/errors/logs` 逐层挖出第一句可读文本放进 `error.message`（不再打印成 `[object Object]`），另附 `details.requestId`（找 ModelScope 排查用）与 `details.raw`（截断后的原始 JSON 兜底）。也兼容 OpenAI 同步形态 `{ data: [{ b64_json | url }] }`。**实测坑位**：提交响应会提前回 `task_status: "SUCCEED"` 而任务其实还在跑，因此只要响应里没有图片且有 `task_id` 就一律以轮询结果为准。`data.size` 报的是**真实解码像素**（不是请求值），二者不一致时附 `E_SIZE_MISMATCH` 警告。

`modelscope-image-fast`（快速档）与 `modelscope-image-gen` **是同一套选项、只有默认值不同**：模型默认 `Qwen/Qwen-Image-2.1-Turbo`、`--steps 8`、`--guidance 1`、`--size 2048x2048`（网关每边实测上限），输出前缀改成 `modelscope-fast-`。实测（2026-10-14）：`2048x2048` 端到端 **37.1s**，PIL 复核确实是 2048×2048 真实像素；**同一把 key 4 路并发提交全部成功并各自出图**——上面「按 key 单并发、并发直接 429」那条结论只对 `Qwen/Qwen-Image-2.1` 成立，要并行批量出图优先用 fast。模型页元数据里的 `SupportApiInference: false` **不可信**（在用的 `Qwen/Qwen-Image-2.1` 同样标 false，实测经网关可调）。

两条 modelscope 命令共用的网关硬限（实测 2026-10-14）：**prompt 上限 4000 字符**，4001 被网关拒（`invalid prompt or prompt length more than 4000`），且**按字符计不按字节**（4000 个汉字 = 12000 UTF-8 字节可通过）；超限现在由本地预检直接报 `E_INVALID_OPTION`（`details.limit`/`details.actual`），不发请求、不吃额度。尺寸仍按每边 `[64, 2048]` 校验。

⚠️ **ModelScope 的任务记录约 10 分钟后过期**：之后再轮询同一个 `task_id` 会回 `task not found`（形如 `{"errors":{"code":500,"message":"task not found"},"task_status":"FAILED"}`）。所以命令**拿到结果就立刻下载**（下载不带 apikey），不存在「事后补拉结果 URL」的用法——过期只能重新提交。

### agnes（Agnes 2.5 Flash 生图/生视频）

```bash
# ~/.zshrc
export AGNES_BASE_URL="https://apihub.agnes-ai.com"     # 不带 /v1（末尾误填的 /v1 与斜杠会被自动剥掉）
export AGNES_API_KEY="xxxxxxxx"                          # Bearer token
export AGNES_KEY_POOL="key-a,key-b"                      # 可选：逗号分隔多把，非空即覆盖单 key
export AGNES_IMAGE_MODEL="agnes-image-2.5-flash"         # 可选，有内置默认值
export AGNES_VIDEO_MODEL="agnes-video-2.5-flash"         # 可选，有内置默认值

# 生图：同步接口，一次请求直接返回结果（没有任务轮询）
node dist/media-cli.js --json agnes-image --prompt "一只红苹果放在白桌上，柔和自然光"                # 默认 --size 4K → 实测 4096x4096
node dist/media-cli.js --json agnes-image --prompt "全景山景" --size 4K --ratio 21:9                 # 实测 6272x2688
node dist/media-cli.js --json agnes-image --prompt "快速预览" --size 1K --output preview.png         # 实测 1024x1024，约 10s

# 图生图：参考图可以直接给本地文件——读成 base64 data URI 内联，不用先上传 CDN（与 modelscope 的关键差异）
node dist/media-cli.js --json agnes-image --prompt "保持构图与光照，把苹果换成蓝色玻璃材质" --ref preview.png --output blue.png
node dist/media-cli.js --json agnes-image --prompt "两张参考图同框" --ref https://cdn.example.com/a.png ./b.png --size 2K   # URL 与本地路径可混传，上限 6 张
node dist/media-cli.js --json agnes-image --prompt "只要内联结果不要外链" --format b64

# 生视频：提交 + 轮询，素材只收公网 URL（本地文件先跑 tencent-cos-upload 换 URL）
node dist/media-cli.js --json agnes-video --prompt "a red cube rotating on white background" --seconds 5
node dist/media-cli.js --json agnes-video --prompt "让画面里的人慢慢转身" --images https://cdn.example.com/tmp/a.png
node dist/media-cli.js --json agnes-video --prompt "从 A 画面过渡到 B" \
  --first-frame https://cdn.example.com/tmp/a.png --last-frame https://cdn.example.com/tmp/b.png
node dist/media-cli.js --json agnes-video --prompt "先占个额度" --no-wait                            # 只提交，返回 data.taskId
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AGNES_API_KEY` | 必填（或设 `AGNES_KEY_POOL`） | Bearer token；两者都缺失报 `E_CONFIG` 且不发请求。错 key → 401 |
| `AGNES_KEY_POOL` | 未设则用单 key | 逗号分隔多把（自动 trim），**非空即覆盖** `AGNES_API_KEY`；`data.keyIndex` 只回下标，任何输出都不含 key 原文 |
| `AGNES_BASE_URL` | `https://apihub.agnes-ai.com` | **不写 `/v1`**（客户端自己拼 `/v1/images/generations`；末尾的 `/v1` 与 `/` 会被剥掉） |
| `AGNES_IMAGE_MODEL` | `agnes-image-2.5-flash` | **有内置默认值**（与豆包/ModelScope 的「模型名必填」不同），`--model` 可覆盖 |
| `AGNES_VIDEO_MODEL` | `agnes-video-2.5-flash` | 同上 |
| `AGNES_TIMEOUT_MS` | `360000` | 单次请求与整体重试预算共用的上限；i2i 实测可达 158s，别往小调 |
| `AGNES_POLL_INTERVAL_MS` | `2000` | 仅 `agnes-video` 轮询用 |
| `AGNES_MAX_RETRIES` | `6` | 队列满（503）/限流（429）时**同一把 key 原地退避**的重试次数 |

`agnes-image` 打的是 `POST {base}/v1/images/generations`，**同步返回**，没有提交-轮询两段。`--size` 是**档位**（`1K`/`2K`/`3K`/`4K`）或 `WIDTHxHEIGHT`，默认 `4K`：档位锁的是**面积**，再按 `--ratio` 分配——实测 `1K`+`1:1` = 1024x1024、`2K`+`1:1` = 2048x2048、`4K`+`1:1` = 4096x4096、`4K`+`21:9` = 6272x2688。⚠️ **显式传 `WxH` 会被静默降采样**（实测请求 `2048x1152`、实收 1312x736，比例保住但像素变少），所以**要最大像素只能传 `--size 4K`**；`data.size` 一律报 sharp 解出的真实像素，只有显式 `WxH` 时才与请求值比对并在不一致时附 `E_SIZE_MISMATCH` 警告（档位模式的期望像素本地推不出来，故只如实记录实测值）。`--ratio` 与 `WxH` 形态的 `--size` 二选一。prompt 上限 **10000 字符**，超限本地预检报 `E_INVALID_OPTION` 不发网络。

参考图（`--ref`，实测上限 **6 张**）是 agnes 与 modelscope 最容易选错的地方：**本地文件直接可用**，插件读成 `data:image/<fmt>;base64,` 内联进请求，**不需要先 `tencent-cos-upload`**（实测 4096x4096 / 10.5MB 的 PNG 内联成约 14MB 的 data URI 也被接受）；http(s) URL 原样透传，两种形态可混传。传了 `--ref` 即走图生图，`data.mode="i2i"`，并且结果 URL 的路径段可交叉验证（`/images/t2i/…` vs `/images/i2i/…`）。耗时实测（2026-10-14）：1K 文生图约 10s、4K 约 20–28s、一次 i2i 编辑 **20–158s**；3 路并发文生图全部成功。i2i 通道会间歇回 **HTTP 503 `image queue is full`**（1–3s 内快速失败）——这是 provider 侧容量，**与你的 key、payload 体积都无关**（已专项验证：同一 payload 有时 200 有时 503，很小与很大的请求体都吃过 503），命令在同一把 key 上原地退避重试（`AGNES_MAX_RETRIES`/`AGNES_TIMEOUT_MS`），重试进度写 stderr，调用方只看最终结果。

> ⚠️ **`agnes-video` 的出片行为待实测。** 已实测的是**提交与校验侧**：三种 `--mode`（`text`/`keyframe`/`reference`）的本地校验全部生效，`seconds` 在 provider 侧是 **JSON 字符串**（插件已自动转换，取值 4–12，默认 5），`size` **只接受 `720P`**（其他值本地即拒，provider 直接 400），`images` ≤5、`audios` ≤3，且素材**只收公网 URL**（本地路径报 `E_INVALID_OPTION` 并提示先跑 `tencent-cos-upload`）。**未实测**：一条真实视频都没生成成功过——探测期间视频通道对连续 18 次间隔提交（跨 22 分钟）全部返回 503 `video_queue_full`，更早一个窗口连续 66 分钟同样，而同一把 key 约 94s 后图片通道仍是 HTTP 200（所以是通道容量，不是账号或额度）。因此**视频的时长、`status` 生命周期、轮询路由一律按未知处理**：两条候选轮询路由只用假 id 探过（`/agnesapi?video_id=` → 404 `task not found`，`/v1/videos/{id}` → 400 `task_not_exist`；`/v1/tasks/{id}` 不存在）。另外实测到约 20s 内连发 3 次提交会撞免费档 429、约 3.5 分钟自愈，**批量提交请把间隔拉到 ≥75s**。prompt 长度上限同样待实测，所以未做本地预检。

### tencent-cos（腾讯云 COS 文件上传，换公网 URL）

```bash
# ~/.zshrc —— 两个池：prod 与 test，各有一套桶/前缀/域名
export TENCENT_SECRET_ID="AKIDxxxxxxxx"        # 腾讯云 API 密钥（SecretId）
export TENCENT_SECRET_KEY="xxxxxxxx"           # 腾讯云 API 密钥（SecretKey）
export COS_REGION="ap-guangzhou"
export COS_ENV="prod"                          # 可选：默认池，不设即 prod；--env 单次覆盖
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
| `COS_ENV` | `prod` | 默认池 `prod` \| `test`；不设或为空即 `prod`，`--env` 单次覆盖 |
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

### media-image（图片压缩 / 文字水印 / 合并 PDF / 遮脸 / 宫格加字幕，基于 sharp + pdf-lib）

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

# 遮脸/打码：本地检脸后每张贴一个实心白圆（Apple Vision，离线，需 macOS + swiftc，首次运行编译并缓存）
node dist/media-cli.js --json media-face-cover --input 街拍.jpg                            # → 街拍.covered.jpg
node dist/media-cli.js --json media-face-cover --input 街拍.jpg --scale 1.6                 # 有侧脸/回头人：1.5–1.6 才盖得住
node dist/media-cli.js --json media-face-cover --input 人像/ --output face-cover/ --recursive
node dist/media-cli.js --json media-face-cover --input 街拍.jpg --at 320,180,60 --at 700,220,55   # 漏检人工补圆（与检测结果合并）

# 宫格/分镜加字幕：每格底部叠半透明黑条 + 白字，整图尺寸不变
node dist/media-cli.js --json media-grid-caption --input 分镜页.png --cells cells.json --captions 字幕.json
node dist/media-cli.js --json media-grid-caption --input 九宫格.png --cols 3 --rows 3 --captions 字幕.json     # 规则宫格人工等分，跳过检测
node dist/media-cli.js --json media-grid-caption --input 规则宫格.png --captions 字幕.json --opacity 1        # 传 1 即纯黑不透明
# 真实/倾斜分镜页的完整流水线：先视觉定位 → 人工核对 cells.json → 再压字幕
node dist/media-cli.js --json doubao-grid-locate --input 分镜页.png --output cells.json
node dist/media-cli.js --json media-grid-caption --input 分镜页.png --cells cells.json                        # cells 里已带 text 时可省 --captions
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `FACE_BIN` | 未设则首次运行自动编译 | 仅 `media-face-cover` 用：指向现成的 `vision-faces` 二进制以跳过 `swiftc` 编译。默认编译产物按源码哈希缓存在 `~/.media-cli/cache/media-face-cover/`（源码变更自动重编译） |

支持 jpg/jpeg/png/webp；文件夹批量时单张失败不影响其余（失败项记入 `data.failed`）。压缩结果不比原图小时跳过落盘（`skipped: true`），原图永不变大；PNG 为无损优化（不量化），要明显减体积请压 jpg/webp。带 EXIF 方向的图会先摆正到像素再处理。水印文字经 SVG 渲染（sharp 内置，无需 fontconfig 配置），字体由系统字体库解析，缺失时回退默认字体；输出重编码用高画质（jpeg 92 / webp 90 / png 无损）。

`media-to-pdf` 与其他批量命令语义不同：一个目录出**一个** PDF（不是逐张产物），默认每页贴合该图尺寸（像素按 `--dpi` 换算，默认 300dpi），也可用 `--page a4|letter` + `--margin` 固定纸张、`--orientation auto` 让横图自动出横页。页内图片默认重编码为 jpeg（透明区域压白底），`--image-format png` 可保留 alpha。**默认任一张图解码失败即整体报 `E_PROVIDER_ERROR` 且不写出半成品 PDF**，确认能丢页时加 `--skip-broken`（跳过项计入 `data.skipped`，并附 `E_PARTIAL_INPUT` 警告）。

`media-face-cover` 的白圆 = 人脸框内切圆 × `--scale`（默认 1.2，范围 0.5–3），圆心取框中心，实心 `--color`（默认 `#FFFFFF`）。检脸引擎与 `media-cutout` 同源（Apple Vision `VNDetectFaceRectanglesRequest`，本地离线、不打网络），**仅 macOS 14+**，`swiftc` 缺失或非 macOS 报 `E_MISSING_DEPENDENCY`（提示 `xcode-select --install`）。实测（2026-10-14，一张真实 2048x2048 角色图）：检出 3 张正脸、背面人物**不误检**、EXIF 旋转变体的坐标同样正确。**默认 `--scale 1.2` 能把正脸完全盖住，但侧脸会露出眼睛——图里有转向/侧脸人物时请用 `--scale 1.5–1.6`**。漏检的兜底是 `--at x,y,r`（像素、左上原点，可重复传多个），它与自动检测结果合并，**而且 Vision 引擎不可用时只传 `--at` 照样出图**（引擎缺失降级为警告）。**检不到脸不是错误**：输出原图副本 + `E_NO_FACE_DETECTED` 警告 + exit 0，判断有没有真盖住要看 `data.covered` 而不是退出码。目录批量复用本插件的批量语义（默认输出目录 `./face-cover`，单张失败记入 `data.failed`）。

`media-grid-caption` 的版式是「每格底部半透明黑条（`--opacity` 默认 0.75，传 `1` 即纯黑）+ 白字居中 + 自动字号自动换行」，**整图尺寸不变**；默认字体族 `sans-serif` 实测能渲染真实中文（全分辨率目视复核，不是豆腐块），`--font` 传的是**字体族名不是字体文件路径**。定位三级优先级：`--cells` > `--cols`/`--rows` 等分 > 本地自动检测（`--no-locate` 可关掉最后一级）。本地检测**只认分隔线对齐的规则宫格**（`media-filmstrip` 产物、等分拼图这类）；真实分镜页常见的倾斜/错位面板会被正确判为「不是规则宫格」，然后走**兜底版式**：字幕外扩到整图底部、输出图变高、`data.layout = "fallback-bottom"` + `E_GRID_NOT_DETECTED` 警告 + exit 0——绝不猜一个版式把字压到错地方。`--cells` 的校验是严格拒绝式的：坐标越界、`w/h <= 0`、`index` 重复、`image.width/height` 与实际解码尺寸不符都报 `E_INVALID_OPTION`。**重叠按 `--max-overlap`（默认 0.05）分级**（视觉模型的坐标放大回原图必然带几像素薄条——实测残留 3.5%–4.6%，一律拒收等于把 `doubao-grid-locate` 的产物打回去；该阈值与产出侧 5% 修复窗口同值，构成「产出侧发得出来、消费侧就必收」的不变量）：占较小格面积 ≤ 阈值 → `E_CELLS_OVERLAP` 警告 + 照常渲染 + exit 0；> 阈值（实测真误检是 11%–33%）→ `E_INVALID_OPTION`（exit 2），报错里给的出路是加 `--allow-overlap` / 直接编辑那份 JSON 改成共边 / 改用 `--cols/--rows` 等分。`data.minorOverlaps` 与 `data.maxOverlap` 把这次分级结果留在输出里。格数与字幕条数不匹配只附一条 `E_PARTIAL_INPUT` 警告（同时讲清哪些格没字、哪些字幕没落格），不失败；单条字幕最多 4 行，再长截断加 `…` 并附 `E_TEXT_TRUNCATED`。本命令**不支持目录批量**（字幕文本与图一一对应，批量语义不清）。

字号字段有一套口径，别只盯 `fontSize`：`data.fontSize` **只是 `--font-size` 选项的回显**（没传就是 `null` = 自动档，与 `media-watermark` 同语义）；实际画出来的字号看 `data.minFontSize` / `data.maxFontSize`（聚合区间，一格都没画时是 `null`）与 `data.fontSizePerCell`（仅 in-cell 版式：`[{index, fontSize}]` 每格真值）。每格字号优先级：`cells[].fontSize` > `--font-size` > 按格宽自动档。兜底版式整条只有一个字号，`min` 与 `max` 同值且没有 `fontSizePerCell`。

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
