# 阶段 08 — BananaRouter gpt-image-2 + MiniMax 语音/音乐/视频 + 豆包 Seedream 生图

> 日期：2026-10-18。前置依赖：阶段 01–07（错误码、鸭子类型抛错、插件契约均已就绪）。
> 目标：新增三家 provider 能力，全部走既有插件体系与 `--json` 契约；**不新增错误码、不改 `src/`**。
> 本文件是本次执行的唯一计划源；实现完成后回填实测结论。

## 1. 用户需求

1. **BananaRouter `gpt-image-2`**：默认高质量（`quality=high`），配置 `BANANA_IMAGE_API_KEY`、`BANANA_IMAGE_API_BASE`。（2026-10-19 修订：用户改判默认 `low`，见 D36。）
2. **MiniMax**：语音生成、音乐生成、视频生成。配置 `MINIMAX_API_KEY`、`MINIMAX_API_BASE_URL`（用户原文写作 `MINIMAX_API_BASR_URL`，按笔误处理，插件兼容两者）。
3. **豆包**：接入图像模型 `doubao-seedream-4-5-251128`。
4. 配置统一写入 `~/.zshrc`（仅本机，不进仓库）。

## 2. 已核实事实（2026-10-18）

### BananaRouter

- 该 token 的 `GET /v1/models` 只返回 `gpt-image-2`（按 token 逐模型授权）。
- OpenAI Image API 兼容：`POST {base}/v1/images/generations`、`POST {base}/v1/images/edits`，Bearer 鉴权。
- `quality` 支持 `auto|low|medium|high`；用户要求默认 `high`（2026-10-19 改为默认 `low`）。
- `size` 支持 `auto` 或 `WxH`：每边 ≤3840、必须是 16 的倍数、长短边比 ≤3:1、总像素 655360–8294400；常用 `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`。
- 成功响应 `{ data: [{ b64_json, revised_prompt? }] }`；可显式传 `response_format: "b64_json"`。
- edits 支持 multipart `image[]`（本地文件）或 JSON `images`（URL/base64）；本插件只走 multipart 本地文件。
- 401 → key 无效；403/429/5xx 按 provider 错误处理（本期单 key，不做池轮换）。
- 历史实测延迟抖动大（低至 65s 到 159s），默认超时取 300000ms。

### MiniMax

- Base URL `https://api.minimaxi.com/v1`（国际站 `api.minimax.io` 同构），Bearer JWT。
- `GET /v1/models` 只列文本模型，不代表多模态能力；语音/音乐/视频模型不在清单里。
- **语音** `POST /v1/t2a_v2`：`{ model, text, stream:false, voice_setting:{voice_id,speed,vol,pitch} }`；响应 `data.audio` 为 **hex** 音频，`base_resp.status_code=0` 才是成功。
  - 实测 `audio_setting` 校验很严（传 sample_rate/bitrate 组合会报 `invalid params: audio_setting bitrate`），**默认不传**，输出 mp3。
  - 系统音色如 `female-shaonv`、`male-qn-qingse`；默认 `female-shaonv`。
- **音乐** `POST /v1/music_generation`：`model=music-3.0`，`prompt`（风格）+ `lyrics`（非纯音乐必填，或 `lyrics_optimizer:true` 自动生成），`is_instrumental` 纯音乐开关；响应 `data.audio` 为 hex；全曲约 10MB、同步耗时 >30s。同样**不传 `audio_setting`**。
- **视频** `POST /v2/video_generation`（**不是 v1**）：`{ model:"MiniMax-H3", content:[{type:"text",text}], resolution, duration, ratio }` 四项必填；返回 `{task_id}`。
  - 轮询 `GET /v2/query/video_generation/{task_id}`：`status` 为 `queued|running|succeeded|failed|cancelled`；成功取 `task.content.url` 下载，失败取 `task.error.{code,message}`。
  - H3：`resolution=768P|2K`、`duration=4..15`；H3-Max：`480P|768P`、`duration=5..15`。纯文生视频 `ratio` 不能是 `adaptive`，枚举 `21:9|16:9|4:3|1:1|3:4|9:16`。
  - 实测 H3 5s/768P/16:9 约 118s 出片，成片自带音轨；默认超时 900000ms。
- **视频再生** `POST /v2/video_regeneration`（官方文档 2026-10-19）：把 H3 产出的 **768P** 成片升 **2K**，入参二选一——`{ model, source_task_id, resolution:"2K" }`（按已有 768P 成功任务，须当前账号、7 天内、`status=succeeded`）或 `{ model, content:[{type:"text",text}], ... , resolution:"2K" }`（`content` 里恰好一个 `role=base_video` 的 `video_url`，须配非空 `text`）。`resolution` 必填且当前**只支持 2K**；`ratio`/`duration` 跟随源视频、不传。再生任务 `task_type=regeneration`，走**同一套** query/list/cancel 端点。**不是通用超分**：源视频须是本模型 768P 成片，外部视频会被拒。官方请求体示例的 `model` 为 `MiniMax-H3`（部分第三方网关名为 `MiniMax-H3-Regeneration`）。
- 错误一律先看 HTTP 状态，再看 `base_resp.status_code`（音频侧）/ `task.error`（视频侧）：1004/2049 → key 无效（`E_CONFIG`）；1008 余额不足；1002/1039 限流；2013 参数异常。

### 豆包 Ark

- `POST {base}/images/generations`，`doubao-seedream-4-5-251128` 实跑通过：2048x2048 约 7.1s。
- **尺寸有像素下限**：`1024x1024`（1,048,576 px）会被拒（要求 ≥3,686,400 px）；默认 `2048x2048`。
- 产物是 TOS 签名 URL（约 24h），下载即用；实际编码 JPEG。
- `watermark:false`、`sequential_image_generation:"disabled"` 均被接受。
- 该账号 seedance 视频全系未开通，本期不接豆包视频。

## 3. 决策

| # | 决策 | 理由 |
|---|---|---|
| D35 | 新插件 `plugins/banana-image/`，命令 `banana-image-gen` | 与 `azure-image`/`modelscope-image` 同构；命令前缀避免与默认 `image-gen` 冲突 |
| D36 | `banana-image-gen` 默认 `--quality low`（2026-10-19 修订，原 `high`）、`--size 1024x1024`、`--output ./banana-<时间戳>.jpeg`；`--ref` 只收本地 jpg/jpeg/png/webp，走 multipart edits；`--size auto` 合法 | 1024² 是最快最便宜的可预测档；参考图能力与 Azure 版对齐；默认 jpeg 是因为 2880² 档 PNG 实测 12–17MB、JPEG 1.3–2.4MB（6–9 倍），用户指定；quality 改 low 是实测（2 组同 prompt/同尺寸对照）low 与 high 的字节数差 ≤1.6 倍且方向不稳定、耗时也不省（158.8s vs 165.4s），高质量档买不到可验证的收益 |
| D37 | 尺寸本地预检（≤3840、16 倍数、比例 ≤3:1、总像素范围），超限 `E_INVALID_OPTION` 且不发网络 | 网关对非法 size 会静默降级成 2880x2880，必须客户端拦截 |
| D38 | 新插件 `plugins/minimax/`，三命令 `minimax-speech` / `minimax-music` / `minimax-video` | 共用 config/client/错误摊平；按模态拆分 lib，单文件 <300 行 |
| D39 | `MINIMAX_API_BASE_URL` 为主名；同时接受用户原文的 `MINIMAX_API_BASR_URL`（前者优先）。base 末尾 `/v1` 自动归一 | 兼容用户已写/将写的变量名；客户端统一拼 `/v1` 与 `/v2` |
| D40 | 语音/音乐默认**不传 `audio_setting`**，输出 mp3；请求 `output_format` 不传（默认 hex），收到 URL 也兼容下载 | 实测 audio_setting 极易触发 400；hex 是已验证路径 |
| D41 | `minimax-video` 只做文生视频（H3/H3-Max），默认 `MiniMax-H3 / 5s / 768P / 16:9`，阻塞轮询并下载；不做图生视频/参考视频 | 用户只要“视频生成”；H3 文生视频已实测；其余形态未验证，不赌 |
| D42 | 豆包生图作为既有 `plugins/doubao/` 的新命令 `doubao-image-gen`，默认模型 `doubao-seedream-4-5-251128`，默认 `2048x2048`、不加水印 | 复用 DOUBAO_API_KEY/BASE_URL；型号写死符合用户点名要求，仍可用 `--model`/`DOUBAO_IMAGE_MODEL` 覆盖 |
| D43 | 三家全部只复用既有错误码 `E_CONFIG` / `E_PROVIDER_ERROR` / `E_MISSING_ARGUMENT` / `E_INVALID_OPTION`，不新增错误码、不改 `src/` | 架构约束；错误细节放 `details.{source,status,baseRespCode,...}` |
| D44 | 测试全部走本地 mock（不依赖真实 key/外网），真机冒烟另做且每项只跑最小档 | 既有 e2e 契约；避免 CI 扣费 |
| D45 | 新增 `minimax-video-regen`（同一 `plugins/minimax/` 插件）：`--source-task-id` / `--base-video` 二选一，`resolution` 固定 `2K`，模型默认 `MiniMax-H3`（env `MINIMAX_VIDEO_REGEN_MODEL`、`--model` 可覆盖为网关名 `MiniMax-H3-Regeneration`）；把生成/再生共用的「提交→轮询→下载」抽到 `lib/video-task.mjs` | 用户点名要接 H3 再生；两种入参是官方二选一契约（`source_task_id` 自动回填、`base_video` 需 `--prompt`），不做局部下采样以避免猜 provider；生命周期抽共用件，避免两份轮询/下载逻辑漂移 |

## 4. 命令契约

### 4.1 `banana-image-gen`

| 选项 | 默认 | 说明 |
|---|---|---|
| `--prompt <text>` | 必填 | 生图/编辑文案 |
| `--ref <paths...>` | — | 本地参考图（jpg/jpeg/png/webp），走 `/v1/images/edits` |
| `--size <WxH\|auto>` | `1024x1024` | 满足 BananaRouter 尺寸约束 |
| `--quality <q>` | `low`（env 可改） | `auto\|low\|medium\|high` |
| `--output <path>` | `./banana-<ISO>.jpeg` | 输出路径（扩展名默认跟随 `BANANA_IMAGE_OUTPUT_FORMAT`） |
| `--model <id>` | `gpt-image-2` | env `BANANA_IMAGE_MODEL` 可覆盖 |

data：`{ path, bytes, format, size, requestedSize, model, quality, qualityDefault, revisedPrompt?, sourceUrl? }`。
真实像素用 sharp 解码；与请求尺寸不一致时附 `E_SIZE_MISMATCH` 警告（与 modelscope/agnes 同口径）。

### 4.2 `minimax-speech`

| 选项 | 默认 | 说明 |
|---|---|---|
| `--text <text>` | 必填 | 最长 10000 字符（本地预检） |
| `--voice <id>` | `female-shaonv` | 系统音色 ID |
| `--speed/--vol/--pitch` | `1 / 1 / 0` | 范围 0.5–2 / (0,10] / -12–12 |
| `--emotion <e>` | — | happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper |
| `--model <id>` | `speech-2.8-hd` | env `MINIMAX_SPEECH_MODEL` |
| `--output <path>` | `./minimax-speech-<ISO>.mp3` | |

data：`{ path, bytes, model, voice, format:"mp3", durationMs, sampleRate?, usageCharacters?, traceId? }`。

### 4.3 `minimax-music`

| 选项 | 默认 | 说明 |
|---|---|---|
| `--prompt <text>` | 纯音乐必填 | 风格/情绪/场景，≤2000 字符 |
| `--lyrics <text>` | 非纯音乐必填（或 `--lyrics-optimizer`） | ≤3500 字符 |
| `--instrumental` | — | 纯音乐，`lyrics` 可省 |
| `--lyrics-optimizer` | — | 由 prompt 自动生成歌词 |
| `--model <id>` | `music-3.0` | env `MINIMAX_MUSIC_MODEL` |
| `--output <path>` | `./minimax-music-<ISO>.mp3` | |
| `--timeout <ms>` | `600000` | 同步接口，全曲响应体可达 10MB |

data：`{ path, bytes, model, format:"mp3", durationMs?, sampleRate?, channels?, bitrate?, traceId? }`。

### 4.4 `minimax-video`

| 选项 | 默认 | 说明 |
|---|---|---|
| `--prompt <text>` | 必填 | 视频描述 |
| `--model <id>` | `MiniMax-H3` | env `MINIMAX_VIDEO_MODEL`；支持 `MiniMax-H3-Max` |
| `--duration <sec>` | `5` | H3 4–15；H3-Max 5–15 |
| `--resolution <r>` | `768P` | H3 `768P\|2K`；H3-Max `480P\|768P` |
| `--ratio <r>` | `16:9` | `21:9\|16:9\|4:3\|1:1\|3:4\|9:16`（t2v 不许 adaptive） |
| `--poll-interval <ms>` | `5000` | 轮询间隔 |
| `--timeout <ms>` | `900000` | 提交+轮询+下载总预算 |
| `--output <path>` | `./minimax-video-<ISO>.mp4` | |

data：`{ path, bytes, model, taskId, durationSec, resolution, ratio, createdAt?, updatedAt?, usage? }`。
超时报 `E_PROVIDER_ERROR`，`details.taskId` 保留，提示任务可能仍在跑。

### 4.5 `doubao-image-gen`

| 选项 | 默认 | 说明 |
|---|---|---|
| `--prompt <text>` | 必填 | |
| `--model <id>` | `doubao-seedream-4-5-251128` | env `DOUBAO_IMAGE_MODEL` 可覆盖 |
| `--size <WxH>` | `2048x2048` | 总像素 ≥3,686,400，本地预检 |
| `--watermark` | 关 | 默认 `watermark:false` |
| `--output <path>` | `./doubao-<ISO>.jpeg` | 产物实际为 JPEG |
| `--timeout <ms>` | `180000` | 单次请求+下载 |

data：`{ path, bytes, model, size, requestedSize, sourceUrl, usage? }`；真实像素用 sharp 解码。

### 4.6 `minimax-video-regen`

| 选项 | 默认 | 说明 |
|---|---|---|
| `--source-task-id <id>` | 二选一 | 按已有 768P 任务 ID 再生；服务端自动回填 prompt/素材 |
| `--base-video <pathOrUrl>` | 二选一 | 按 768P 源视频再生；本地 mp4/mov 读成 data URI 内联，也可 http(s) / `mm_file://`；须配 `--prompt` |
| `--prompt <text>` | `--base-video` 模式必填 | 再生 text 项，≤7000 字符；`--source-task-id` 模式不许传 |
| `--aigc-watermark` | 关 | 给 2K 成片加 AIGC 标识 |
| `--model <id>` | `MiniMax-H3` | env `MINIMAX_VIDEO_REGEN_MODEL`；部分网关用 `MiniMax-H3-Regeneration` |
| `--poll-interval <ms>` | `5000` | 轮询间隔 |
| `--timeout <ms>` | `900000` | 提交+轮询+下载总预算 |
| `--output <path>` | `./minimax-video-regen-<ISO>.mp4` | |

data：`{ path, bytes, model, method:"source_task_id"|"base_video", taskId, resolution:"2K", sourceTaskId?, baseVideo?, createdAt?, updatedAt?, usage? }`。
`resolution` 固定 `2K`（provider 当前仅此一档）；`--base-video` 的本地文件只回字节摘要，base64 不进 stdout。

## 5. 文件清单

```
plugins/banana-image/
  index.mjs              # manifest：banana-image-gen
  lib/env.mjs            # key/base/model/quality/timeout
  lib/size.mjs           # auto 与 WxH 约束校验
  lib/client.mjs         # generations JSON / edits multipart、错误摊平
  lib/errors.mjs         # cliError
  lib/run.mjs            # handler：校验→请求→写盘→真实像素

plugins/minimax/
  index.mjs              # manifest：speech / music / video / video-regen
  lib/config.mjs         # env、base 归一、命令默认值
  lib/errors.mjs         # cliError
  lib/client.mjs         # POST/GET、timeout、HTTP 与 base_resp 映射
  lib/audio.mjs          # hex/URL → Buffer、写文件
  lib/speech.mjs         # minimax-speech handler + body
  lib/music.mjs          # minimax-music handler + body
  lib/video-params.mjs   # minimax-video 参数解析与请求体
  lib/video-media.mjs    # 多模态媒体解析与本地预检（含 --base-video）
  lib/video-task.mjs     # 生成/再生共用的任务生命周期（提交→轮询→下载）
  lib/video.mjs          # minimax-video handler
  lib/video-regen.mjs    # minimax-video-regen 参数/请求体/handler

plugins/doubao/
  lib/image.mjs          # doubao-image-gen handler + body + size 校验
  index.mjs              # 追加命令声明

tests/unit/banana.test.ts
tests/unit/minimax.test.ts
tests/unit/doubao-image.test.ts
tests/e2e/helpers/provider-mock.ts
tests/e2e/banana-image.e2e.test.ts
tests/e2e/minimax-speech-music.e2e.test.ts
tests/e2e/minimax-video.e2e.test.ts
tests/e2e/minimax-video-regen.e2e.test.ts
tests/e2e/doubao-image.e2e.test.ts
```

文档同步：`README.md`、`skills/media-cli/SKILL.md`、`package.json`（description/keywords）、
`docs/plans/media/00-master-plan.md`（环境变量表 + 阶段索引）。

## 6. 测试计划

### unit

- Banana：key 缺失 → `E_CONFIG`；base 归一；size 合法/非法（auto、非 16 倍数、比例 >3:1、像素越界）；quality 白名单。
- MiniMax：base 归一（含 `/v1`、末尾斜杠、`BASR` 别名）；TTS/音乐/视频 body 构造；H3 与 H3-Max 的 resolution/duration 校验；ratio 枚举；`base_resp` 错误映射；音乐歌词校验。
- 豆包：size 解析与像素下限；body 默认 `watermark:false`/`response_format:"url"`；模型默认值。

### e2e（本地 mock，真 spawn dist）

- Banana：generations 成功 b64 落盘 + 请求体默认 quality=low；edits multipart 带参考图；非法 size 零请求；401 → `E_CONFIG`；假 PNG → 真实尺寸/`E_SIZE_MISMATCH`。
- MiniMax speech/music：hex 落盘、请求体不含 `audio_setting`、base_resp 1004 → `E_CONFIG`、1008 → `E_PROVIDER_ERROR`、歌词校验零请求。
- MiniMax video：提交 → running → succeeded → 下载 mp4；failed → `E_PROVIDER_ERROR` 带 task.error；参数校验零请求。
- MiniMax video-regen：`--source-task-id` 体只带 `{model,resolution:"2K",source_task_id}`；`--base-video` 体为 `content:[text, role=base_video]`；failed → `E_PROVIDER_ERROR`；缺失/互斥/超长/未知 scheme 零请求；spec 列出全部选项。
- 豆包生图：返回 URL → 下载落盘；默认模型/尺寸/watermark；1024x1024 本地拒绝零请求。
- 所有新 e2e 文件 `vi.setConfig({ testTimeout: 30_000 })`（media-27 的教训）。

## 7. 验收标准

```bash
pnpm lint
pnpm build
pnpm test
node dist/media-cli.js --json spec | grep -E 'banana-image-gen|minimax-(speech|music|video|video-regen)|doubao-image-gen'
```

- 上述命令全绿；新命令 `--json` 成功/失败包络符合壳契约。
- `spec` 能列出 6 个新命令，source 为对应 `plugin:<name>`。
- e2e 不依赖真实 key；任何输出不包含 key 原文。
- 真机冒烟（需用户确认后执行，均为最小计费档）：
  - `banana-image-gen --prompt ... --size 1024x1024 --quality high`
  - `minimax-speech --text "你好"` + `minimax-music --instrumental --prompt ...`
  - `minimax-video --prompt ... --duration 5 --resolution 768P`
  - `doubao-image-gen --prompt ...`（2048x2048）

## 8. 禁止事项

- 不改 `src/`、不新增错误码、不改退出码。
- 不引入任何 npm 依赖（Node 原生 fetch/FormData/Blob + 已有 sharp）。
- 不写交互式 prompt，不写 stdout/stderr（只用 `ctx.logger` 与 return/throw）。
- 不在仓库内写入任何真实 key；`.zshrc` 只在用户本机追加。
- 不把 MiniMax `audio_setting` 作为默认字段发送。

## 增补（media-33，2026-10-19 实测）

- `banana-image-gen` 新增 `--moderation`（env `BANANA_IMAGE_MODERATION`，默认 `low`，枚举 `auto|low`；网关原文 `moderation must be one of: auto, low`），JSON 与 multipart 两条路径都带。
- `--ref` 改为**本地路径与 http(s) URL 混传**：全本地仍走 multipart `image[]`（不动既有已验证路径）；一旦含 URL 就整体改走 `application/json` 的 `images` 数组，本地文件内联成
  `data:<mime>;base64,`，URL 交给网关下载（单图 ≤20MB、超时 30s、单请求内 ≤5 并发、私有/保留 IP 被 SSRF 拒、允许 jpeg/png/gif/webp/bmp）。实测 URL / data URI / 纯 base64 /
  `{"image_url":…}` 四种元素形态都被真消费（给不可解析域名回 `failed to download 1 image(s): …`）。
- 带 scheme 的非 http(s) 入参本地即拒（`E_INVALID_OPTION`，零请求）：网关对这类字符串不走协议分支而当 base64 解码，`file:///…` 报 `illegal base64 data`，错误信息会把排查引错方向。
- 顺序坑：**参考图下载先于参数枚举校验**，所以探 edits 的枚举参数探不出来，要用 generations 探。`mask` 文档写「暂未支持」，但网关确实会去下载 `mask` URL——下载不等于转发上游生效，未判死。
