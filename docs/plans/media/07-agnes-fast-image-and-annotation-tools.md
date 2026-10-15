# 阶段 07 — agnes 生图/生视频 + ModelScope 快图 + 三个本地图像工具

> 前置依赖：阶段 01–06，以及已落地但未单独出计划文档的 media-17～20（modelscope-image、media-to-pdf、tencent-cos、key 池）。
> 目标：接入 agnes 图片/视频 provider；给 ModelScope 加一个快速文生图命令；新增「白圆遮脸」「宫格加字幕」「视觉模型定位宫格」三个工具。
> **本文档面向低端模型执行**：每节都给了文件清单、函数签名、验收命令与禁止事项，照做即可，不要自行发挥架构。

## 范围

**做**：
1. 新插件 `plugins/agnes/`（命令 `agnes-image`、`agnes-video`）
2. `plugins/modelscope-image/` 新增命令 `modelscope-image-fast`
3. `plugins/media-image/` 新增命令 `media-face-cover`（白圆遮脸）、`media-grid-caption`（宫格加字幕）
4. `plugins/doubao/` 新增命令 `doubao-grid-locate`（视觉模型定位宫格）
5. `~/.zshrc` 写入 agnes 环境变量块 + `DOUBAO_VISION_MODEL`
6. `skills/media-cli/SKILL.md`、`README.md`、`package.json` 同步

**不做**：
- 不新增任何错误码（见 D34），**`src/` 目录一行都不改**
- agnes-video 不做本地文件代传 COS（只收公网 URL）
- 宫格工具不做「把多张图拼成宫格」（那是另一个需求，已有 `media-filmstrip` 走 ffmpeg）
- 遮脸不做模糊/马赛克（只做白圆，见 D28）
- 不做非 macOS 的人脸检测回退引擎

## 决策（grill-me 2026-10-14 逐条确认）

| # | 决策 | 理由 |
|---|---|---|
| D19 | agnes 单插件 `plugins/agnes/`，两个命令 `agnes-image` + `agnes-video` 共用 `lib/` | env/key 池/错误摊平/退避重试只写一次；video 未实测，与 image 同插件便于探测后回填 |
| D20 | `agnes-image --ref` 收**本地文件或公网 URL**：本地文件读成 `data:<mime>;base64,` 内联，http(s) 原样透传，上限 6 个。`agnes-video` 的 `--images/--first-frame/--last-frame/--audios` **只收公网 URL**，本地路径 → `E_INVALID_OPTION` 并提示先跑 `tencent-cos-upload` | 用户选定。image 实测 base64 与 URL 都可用；video 文档只写公网 URL 且未实测，不赌 |
| D21 | `agnes-image` 默认 `--size 4K`；档位=面积（1K→1024²，4K→4096²，4K/21:9→6272x2688）。**显式 `WxH` 会被降采样**（实测 2048x1152 → 1312x736），因此 `data.size` 必须报 sharp 解出的真实像素，与请求不符时附 `E_SIZE_MISMATCH` 警告 | 用户要「最大尺寸输出」；沿用 modelscope-image 已有的真实像素契约 |
| D22 | HTTP **503 `image queue is full` 只退避重试，不换 key**；401/403/429/5xx(除503) 才在 key 池内轮换 | 实测：同一 payload 有时 200 有时 503，URL 参考图与 base64 同时 503，而纯文生图同时段 200 → 是 i2i 队列饱和，与 key 无关，换 key 无用 |
| D23 | 支持 `AGNES_KEY_POOL`（逗号分隔），未设置则退回 `AGNES_API_KEY`；提交期随机起点轮换，异步任务轮询钉住提交那把 key；`data.keyIndex` 只回下标 | 与 `MODELSCOPE_KEY_POOL` / `AZURE_IMAGE_KEY_POOL` 完全一致的房子风格；用户要求预留 |
| D24 | `AGNES_BASE_URL` 写 **`https://apihub.agnes-ai.com`（不带 `/v1`）**；`lib/env.mjs` 额外容忍用户误填带 `/v1` 的形式（裁掉尾部 `/v1` 与 `/`） | 官方文档给的 base 带 `/v1`，与仓库约定冲突；实测不带 `/v1` 时 `/v1/images/generations` 正常 |
| D25 | 新增**独立命令** `modelscope-image-fast`，默认 `Qwen/Qwen-Image-2.1-Turbo` + `steps=8` + `guidance=1`；同时把 `--guidance` 下限从 `1.5` 放宽到 `1` | 用户选定独立命令。**必须放宽下限**：现有 `plugins/modelscope-image/index.mjs:136` 的 `min: 1.5` 会拦掉 Turbo 官方默认的 CFG=1 |
| D26 | prompt 长度**本地预检**：modelscope 系 4000 字符、agnes-image 10000 字符，超限直接 `E_INVALID_OPTION`（details 带 `limit` 与实际长度），不发网络 | 实测网关确实硬拦（见 §1），本地预检省额度、错误更清楚 |
| D27 | `media-face-cover` 归 `plugins/media-image/`；引擎 = Apple Vision `VNDetectFaceRectanglesRequest`，Swift 单文件 + swiftc 运行时编译缓存（完全照抄 `media-cutout` 的 `resolveCutoutBin` 套路，env 覆盖名 `FACE_BIN`，缓存目录 `~/.media-cli/cache/media-face-cover/`）。**检不到脸不失败**：输出原图副本 + `E_NO_FACE_DETECTED` 警告 + exit 0。`--at <x,y,r>` 可重复，作为人工兜底（与检测结果合并） | 用户选定。离线、ANE 加速、零模型下载；`media-cutout` 已有可抄的成熟实现 |
| D28 | 白圆 = 人脸框**内切圆 × `--scale`（默认 1.2）**，圆心=框中心，实心 `--color`（默认 `#FFFFFF`），SVG `<circle>` 由 sharp/librsvg 光栅化（自带抗锯齿）。输出 sidecar `<name>.covered.<ext>`，`--output` 可覆盖；`--input` 为目录时复用 `media-image` 的 `runBatch`（`sidecarTag: "covered"`，默认输出目录 `./face-cover`） | 用户选定。1.2 倍是为盖住发际线与下巴（Vision 的框通常偏紧） |
| D29 | `doubao-grid-locate` 归 `plugins/doubao/`，复用现成的 `lib/ark.mjs` 的 `chatWithRetry` + `extractText`。模型 id **不写死**：读 `DOUBAO_VISION_MODEL`，缺失则由 `--model` 兜底，两者都缺 → `E_CONFIG`（`details.var = "DOUBAO_VISION_MODEL"`） | 用户确认 `doubao-seed-2-1-lite-260915` 可用（该模型已在收 base64 音频，收图同理）。不写死是 `plugins/doubao/lib/config.mjs:7` 的既有房子规则：豆包型号按月更新 |
| D30 | **cells JSON 统一 schema**：`doubao-grid-locate` 的 `data` 就是 `media-grid-caption --cells` 能直接吃的格式，中间零转换、可落盘人工修改后复用。schema 见 §2（冻结，不得改动字段名） | 用户选定 |
| D31 | `media-grid-caption` 归 `plugins/media-image/`；正常版式 = **每格底部叠半透明黑条 + 白字居中 + 自动换行 + 自动字号，不改变整图尺寸**。`--opacity` 默认 `0.1`（2026-10-15 用户指定，由 0.75 改；注意 0.1 只轻微压暗，亮底白字对比度低），传 `1` 即纯黑 | 用户选定「格内底部黑条（不改尺寸）」+「半透明黑底白色文字」 |
| D32 | 定位优先级：`--cells` > `--cols/--rows` 等分 > 本地自动检测（`--locate`，默认开启）。**三级全失败 → 兜底：整图底部向外扩一条半透明黑边，N 条字幕按 index 顺序逐行居中**，输出图变高，`data.layout = "fallback-bottom"` + `E_GRID_NOT_DETECTED` 警告 + exit 0 | 用户原话「字幕放在图片最下方」「在底部往外扩，增加图片像素作为字幕即可，同样是半透明黑底白色文字」 |
| D33 | 字体默认 `sans-serif`（**本机实测能正确渲染中文**），`--font <family>` 传字体族名（不是文件路径）。注意 `/System/Library/Fonts/PingFang.ttc` 在本机**不存在**，但 `PingFang SC` / `Hiragino Sans GB` / `STHeiti` / `sans-serif` 经 fontconfig 都能解析出中文字形。e2e 必须断言渲染墨迹量 > 0，防止 tofu/空图静默产出 | 实测结论，见 §1.4 |
| D34 | **不新增任何错误码**，全部复用现有 12 个（`E_USAGE` / `E_INVALID_OPTION` / `E_MISSING_ARGUMENT` / `E_CONFIG` / `E_PROVIDER_ERROR` / `E_MISSING_DEPENDENCY` / `E_INTERNAL` 等）。新增的 `E_NO_FACE_DETECTED` / `E_GRID_NOT_DETECTED` / `E_SIZE_MISMATCH` / `E_PARTIAL_INPUT` 都是 **warning code**，按 `src/core/output/warnings.ts` 的约定 warning code 不需要登记 | 结论：本阶段**完全不动 `src/`**，风险面只在新插件与文档 |
| D35 | 计划文档 = 本文件；执行分 **5 个 commit**：`media-21` agnes → `media-22` modelscope-image-fast → `media-23` media-face-cover → `media-24` doubao-grid-locate + media-grid-caption → `media-25` skill/README/package.json 汇总。每个 commit 前 `pnpm lint && pnpm build && pnpm test` 必须全绿 | 用户选定。每个 commit 独立可验收，回滚粒度合适 |

---

## 1. 实测事实基线

> **数字纪律（硬性）**：本节所有数字都是 2026-10-14 真实跑出来的。写进 `README.md` / `SKILL.md` 的任何数字**必须**来自本节或来自 §6 的探测回填，**禁止编造、禁止从文档抄未验证的值**。未实测的一律写 `待实测`。

### 1.1 agnes-image（已实测，可直接写文档）

- 端点：`POST {AGNES_BASE_URL}/v1/images/generations`，**同步**返回（不是异步任务）
- 鉴权：`Authorization: Bearer <key>`；错 key → **401**
- 参数错 → **400**，body = `{"error":{"message":"...","type":"invalid_request","param":"","code":"invalid_request"}}`
- provider 侧错误 → `type` 可能是 `"AgnesAI_error"`
- 队列满 → **503**，body = `{"error":{"message":"image queue is full, please retry later (request id: ...)","type":"","param":"","code":null}}`，**1–3 秒快速失败**

| 项 | 实测值 |
|---|---|
| 模型 id | `agnes-image-2.5-flash`（文档另提 `agnes-image-2.1-flash`，API/价格相同） |
| `size` 合法值 | `1K` / `2K` / `3K` / `4K` / `WIDTHxHEIGHT`。非法值 400：`size has invalid value "8K"; must be one of: 1K, 2K, 3K, 4K, or WIDTHxHEIGHT` |
| 档位=面积 | `1K`+`1:1` → **1024x1024**（887KB PNG，10.3s）；`4K`+`1:1` → **4096x4096**（6.8MB，20s）；`4K`+`21:9` → **6272x2688**（10.9MB，28s）。推断规则：档位定面积（1K≈1024²、4K≈4096²），再按 ratio 分配、对齐到 16 的倍数 |
| ⚠️ 显式 WxH 被降采样 | 请求 `2048x1152` → 实际 **1312x736**（保比例、缩小）。**要最大尺寸只能用 `4K` 档** |
| `ratio` | `1:1`(默认) / `3:4` / `4:3` / `16:9` / `9:16` / `2:3` / `3:2` / `21:9` |
| prompt 上限 | **10000 字符**，超限 400：`prompt exceeds 10000 characters` |
| 参考图张数上限 | **6 张**，超限 400：`too many input images: 8 provided, at most 6 allowed`（`type: "AgnesAI_error"`） |
| 参考图形态 | 公网 HTTPS URL ✓、`data:image/png;base64,` data URI ✓（**与 payload 体积无关**：453 字节与 1.18MB 都出现过 200 与 503，503 纯由队列状态决定） |
| 参考图放哪 | `extra_body.image`（**数组**，单张也要数组） |
| `response_format` 放哪 | **必须**在 `extra_body.response_format`，放根级会报验证错。值 `url` 或 `b64_json` |
| 并发 | 纯文生图 **3 路并发全部成功**，wall 11s（单路 10–11s）。i2i 并发未测（探测期间队列一直满） |
| i2i 耗时 | **20–98s**，波动极大；必须给足超时预算 |
| 输出 URL 路径可辨模式 | 文生图 `…/images/t2i/task_*/output_<hash>.png`；图生图 `…/images/i2i/task_*/output.png`。**可用来验证是否真走了编辑** |
| 成功响应体 | `{"data":[{"url":"...","b64_json":"","revised_prompt":""}],"created":<unix秒>,"task_id":"task_..."}`。注意：文档说 `revised_prompt` 是 `null`，**实测是空字符串**；文档没提根级 `task_id`，**实测有** |

### 1.2 agnes-video（**完全未实测**，仅官方文档；执行时必须先做 §6 的 V0 探测）

- 提交：`POST {base}/v1/videos`；轮询：`GET {base}/agnesapi?video_id=<id>&model_name=agnes-video-2.5-flash`
  - ⚠️ 轮询路径 `/agnesapi` **不在 `/v1` 下**，很反常，必须实测确认（含是否需要 auth header）
- `model` = `agnes-video-2.5-flash`
- `mode`（必填）= `text` | `keyframe` | `reference`
- `seconds` = **字符串** `"4"`–`"12"`，默认 `"5"`
- `size` = **只支持 `"720P"`**，其他值直接 400 `"size must be 720P"`
- `aspect_ratio` = `21:9`/`16:9`(默认)/`4:3`/`1:1`/`3:4`/`9:16`
- `first_frame` + `last_frame`：`keyframe` 模式必填成对，公网 URL
- `images`：公网 URL 数组，**最多 5 张**（`images length must not exceed 5`）
- `audios`：公网 URL 数组，**最多 3 个**
- `videos`：**明确不支持**（`videos is not supported`）
- `seed`：整数可选；`n`：固定 1
- prompt 内可用 `<Picture N>` / `<Audio N>` 引用素材
- 完成判定：`status == "completed"` 时取**顶层 `url`** 字段；**忽略** `internal_status` 与 `internal_progress`（文档明确要求，实测示例里 `internal_status` 是 `pending` 而 `status` 已 `completed`）
- 错误：400 + 单个 `detail` 键；多规则违反时只按优先级 `size → images → audios → videos` 返回第一条
- 轮询间隔建议 1–2s

> 用户原话「最大免费参考图」按 **`images` 上限 5 张** 理解。若探测发现免费额度另有更严的限制，以探测结果为准并回填。

### 1.3 ModelScope（已实测）

| 项 | 实测值 |
|---|---|
| Turbo 模型 id | `Qwen/Qwen-Image-2.1-Turbo`，**网关可直接调**。⚠️ 模型页元数据 `SupportApiInference` 显示 `false` 但**该字段不可信**——已在用的 `Qwen/Qwen-Image-2.1` 同样是 `false` |
| prompt 上限 | **4000 字符**（`4001` 被拒），错误串：`invalid prompt or prompt length more than 4000`。base 2.1 与 Turbo **同一规则**（网关级校验）。按**字符**计不按字节：4000 个汉字（=12000 UTF-8 字节）可通过 |
| 每边范围 | `[64, 2048]`，错误串：`width must be integer in [64,2048]` |
| 最大尺寸 | `2048x2048` 请求 → **真出 2048x2048**（3.1MB PNG） |
| Turbo 耗时 | 2048x2048 约 **25–30s** |
| 并发 | **同一把 key 4 路并发提交全部成功且各自出图** |
| Turbo 图生图 | `image_url`（数组）可用，实测 SUCCEED |
| 提交响应 | `{"task_status":"SUCCEED","task_id":"...","request_id":"..."}` —— 这个 `SUCCEED` 只代表**提交成功**，不代表生成完成（现有代码已按此处理） |
| 轮询 | `GET {base}/v1/tasks/{id}` + header `x-modelscope-task-type: image_generation` → `output_images[]` |
| ⚠️ 任务记录会过期 | 约 **10 分钟**后再轮询同一 task_id → `{"errors":{"code":500,"message":"task not found"},"task_status":"FAILED"}`。**必须及时下载，不能事后补拉**——这条要写进 SKILL.md 坑位 |

### 1.4 本机环境实测（图像工具相关）

- `sharp ^0.35.4` 与 `pdf-lib ^1.17.1` 已在 `package.json` dependencies 中，**不需要新增依赖**
- 中文字体渲染实测（sharp + SVG `font-family`，字号 44，11 个中英混排字符）：

  | 字体族 | 墨迹像素 | 文字宽 |
  |---|---|---|
  | `sans-serif`（现有默认） | 5318 | 466 |
  | `PingFang SC` | 5145 | 463 |
  | `Hiragino Sans GB` | 4794 | 486 |
  | `STHeiti` | 4424 | 470 |
  | `Heiti SC` | 4356 | 469 |
  | `Songti SC` | 3612 | 450 |
  | `Arial Unicode MS` | 5470 | 466 |

  → 全部能正确渲染中文，**用默认 `sans-serif` 即可**。`/System/Library/Fonts/PingFang.ttc` 文件不存在但 `PingFang SC` 族名仍可解析。
- 可复用的现成原语（`plugins/media-image/lib/watermark.mjs`）：
  - `escapeXml(text)` — SVG 注入防护，**渲染任何用户文本前必须过一遍**
  - `autoFontSize(width, height)` = `min(160, max(14, round(min(w,h)/24)))`
  - `measureText(sharp, { text, font, fontSize, color, opacity })` → `{ width, height }`；渲染为空时抛 `E_PROVIDER_ERROR`（`details.source: "sharp"`）——**直接复用它做自动字号与换行**
  - 合成顺序坑：`sharp(file).rotate()` 必须**先于** `.composite([...])`（sharp 管线顺序固定）
  - `lib/options.mjs` 的 `COLOR_RE = /^[#A-Za-z0-9(),.\s%-]{1,64}$/` 是颜色值的既有校验，`--color`/`--text-color` 复用它
- `media-image` 的批处理骨架：`runBatch(ctx, args, { defaultDirName, sidecarTag, processOne })`，注意它读的是 **`args.input`（即 `--input`）不是 `--file`**；扩展名白名单 `[".jpg",".jpeg",".png",".webp"]`（`lib/format.mjs:4`）；sidecar 命名走 `defaultSidecar(input, tag)`（`lib/files.mjs:79`）
- `plugins/doubao/lib/ark.mjs` 的 `chatWithRetry(config, body)` 是**通用** chat/completions 调用器：已内置 408/429/500/502/503/504 + 超时重试（backoff `[400, 1200]`）、401/403 → `E_CONFIG`；`extractText(payload)` 已兼容 `content` 为 string 或数组两种形态。**视觉调用直接复用它，不要另写 HTTP 层**

---

## 2. 冻结契约：cells JSON schema

`doubao-grid-locate` 的 `data` 输出 == `media-grid-caption --cells` 的输入。**字段名冻结，不得增删改名**（新增可选字段需回来改本节）。

```json
{
  "cells": [
    { "index": 0, "x": 0, "y": 0, "w": 512, "h": 512,
      "text": "第一格字幕", "fontSize": 42, "align": "center", "position": "bottom" }
  ],
  "image": { "width": 1024, "height": 1024 },
  "source": "vision",
  "model": "doubao-seed-2-1-lite-260915"
}
```

| 字段 | 必选 | 类型 | 语义 |
|---|---|---|---|
| `cells[].index` | ✅ | int | 阅读顺序序号，从 0 开始（左→右、上→下） |
| `cells[].x` / `.y` | ✅ | int | 格左上角，**像素，左上原点**（不是归一化、不是左下原点） |
| `cells[].w` / `.h` | ✅ | int | 格宽高，像素，必须 > 0 |
| `cells[].text` | ❌ | string | 该格字幕；缺失则该格不写字 |
| `cells[].fontSize` | ❌ int | 覆盖自动字号（6–1000） |
| `cells[].align` | ❌ | `"left"`/`"center"`/`"right"`，默认 `center` |
| `cells[].position` | ❌ | `"bottom"`/`"top"`，默认 `bottom`（格内） |
| `image.width` / `.height` | ✅ | int | 原图像素尺寸，用于越界校验 |
| `source` | ✅ | `"vision"` / `"auto"` / `"manual"` / `"none"` | 定位来源，写进 `media-grid-caption` 的 `data.source` 便于排查。`none` **只出现在 `media-grid-caption` 的输出**（三级定位全失败、走了 fallback-bottom 兜底版式），不会作为 `--cells` 的输入值 |
| `model` | ❌ | string | `source === "vision"` 时回填模型 id |

**校验规则**（`media-grid-caption` 读入时必须执行，任一不满足 → `E_INVALID_OPTION`，`details.cell` 带出错的 index）：
1. `cells` 非空数组
2. 每个 cell 的 `x,y,w,h` 是有限整数，`w > 0 && h > 0`
3. `x >= 0 && y >= 0 && x + w <= image.width && y + h <= image.height`（越界即拒，**不静默裁剪**）
4. `index` 唯一
5. `image.width/height` 与实际解码出的图片尺寸不符 → `E_INVALID_OPTION`（提示 cells 是为别的图生成的）
6. 任意两格**面积重叠**（只共边/共点不算）→ `E_INVALID_OPTION`，`details.overlaps` 带出重叠的两格 index 与重叠尺寸。
   实测危害：视觉模型给的重叠格会让同一格画上两条字幕、其中一条悬浮在格子中间，且当时 exit 0 静默产出废图。
   确认是刻意的分层版式时可用 `--allow-overlap` 显式放行（默认拒绝）。

---

## 3. commit media-21 — `plugins/agnes/`（agnes-image + agnes-video）

### 3.1 目录与文件清单

```
plugins/agnes/
  index.mjs            # 纯 manifest，只 import + 声明（目标 ≤80 行）
  lib/errors.mjs       # 逐字节抄任意现有插件的同名文件（仓库已有 7 份相同拷贝）
  lib/env.mjs          # loadConfig(env) + parseKeys(env)
  lib/error-text.mjs   # scrub / describeFailure / requestIdOf
  lib/client.mjs       # tryRequestJson / isFatalHttp / rotateKeys / withRetry
  lib/image.mjs        # generateImage(config, opts)
  lib/video.mjs        # submitVideo(config, opts) / pollVideo(config, taskId, keyIndex, deadline)
  lib/refs.mjs         # toDataUri(localPath) / splitRefs(values) / assertPublicUrls(values, option)
  lib/output.mjs       # writeResult / actualPixels / resolveOutputPath
  lib/commands.mjs     # agnesImage / agnesVideo 两个 handler + 选项解析纯函数
```

每个文件目标 ≤300 行（AGENTS.md §6 硬约束）。`index.mjs` 采用 `doubao` 的第三种房子风格：handler 从 `lib/` import，`index.mjs` 只做声明。

### 3.2 env 契约（`lib/env.mjs`）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `AGNES_API_KEY` | ✅（或用池） | — | 缺失且 `AGNES_KEY_POOL` 也缺 → `E_CONFIG`，`details.var = "AGNES_API_KEY"` |
| `AGNES_KEY_POOL` | ❌ | — | 逗号分隔多把；**设置后覆盖单 key**（与 modelscope 语义一致） |
| `AGNES_BASE_URL` | ❌ | `https://apihub.agnes-ai.com` | 容忍尾部 `/` 与尾部 `/v1`（都裁掉） |
| `AGNES_IMAGE_MODEL` | ❌ | `agnes-image-2.5-flash` | `--model` 可覆盖 |
| `AGNES_VIDEO_MODEL` | ❌ | `agnes-video-2.5-flash` | `--model` 可覆盖 |
| `AGNES_TIMEOUT_MS` | ❌ | `360000` | 官方建议客户端超时 60–360s；i2i 实测可达 98s |
| `AGNES_POLL_INTERVAL_MS` | ❌ | `2000` | 仅 video 用 |
| `AGNES_MAX_RETRIES` | ❌ | `6` | 仅针对 503 队列满 |

**注意**：与 modelscope 不同，image/video 的 model **有内置默认值**——因为 agnes 的模型 id 是稳定的产品名（`agnes-image-2.5-flash`），不是按月换的豆包型号。这与 D29 不冲突。

`loadConfig(env = process.env)` 必须在 **handler 内**调用（`index.mjs` 顶层零副作用），否则缺 key 会让整个 CLI 崩。

### 3.3 503 退避重试（`lib/client.mjs`）

```
BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]   // 索引 = 已重试次数，超出取最后一档
重试条件：HTTP 503，或 body 的 error.message 含 "queue is full"
不重试：400（参数错）、401/403（鉴权，交给 key 轮换）、其他 4xx
重试预算：受 AGNES_TIMEOUT_MS 的总 deadline 约束；超过 deadline → E_PROVIDER_ERROR
          details = { source:"agnes", reason:"queue_full_exhausted", attempts:[{status,message,retryAfterMs}], requestId }
重试时 ctx.logger.info(`agnes 队列满，${backoff}ms 后重试（第 n/N 次）`)  ← 写 stderr，不写 stdout
```

**key 轮换与 503 重试的关系（D22，容易搞错，照此实现）**：
- 503 → **只退避重试，keyIndex 不变**
- 401/403/429/5xx(非503)/网络错 → 换下一把 key（随机起点，遍历一圈）
- 400 → 立即 `E_PROVIDER_ERROR`，既不重试也不换 key
- video 的轮询阶段：**钉住提交时那把 key**（任务属于提交它的账号）；轮询撞 429 继续等，不判失败（避免作废已付费生成）——这条是 modelscope 已验证的经验，照搬

所有进入 `message`/`details` 的 provider 文本必须先过 `scrub(text, config.keys)`，输出里**永不出现 key 原文**。

### 3.4 命令契约：`agnes-image`

| 选项 | 默认 | 说明 |
|---|---|---|
| `--prompt <text>` | 必填 | 缺失 → `E_MISSING_ARGUMENT`；> 10000 字符 → `E_INVALID_OPTION`（`details: { option:"--prompt", limit:10000, actual }`） |
| `--size <tier\|WxH>` | `4K` | `1K`/`2K`/`3K`/`4K`/`WIDTHxHEIGHT`；非法 → 本地 `E_INVALID_OPTION`（不发网络） |
| `--ratio <r>` | `1:1` | 8 档枚举；**与 `--size` 的 `WxH` 形态冲突**：若 `--size` 传了 `WxH` 又传 `--ratio` → `E_INVALID_OPTION`（沿用 modelscope-image 的「二选一」语义） |
| `--ref <pathOrUrl...>` | — | variadic，**最多 6 个**（超出本地拦 `E_INVALID_OPTION`，附上限说明）。本地路径 → `toDataUri`；`http(s)://` → 原样。其他 scheme → `E_INVALID_OPTION` |
| `--format <url\|b64>` | `url` | 映射到 `extra_body.response_format` |
| `--output <path>` | `agnes-<ISO时间戳>.png` | 父目录不存在 → `E_INVALID_OPTION`（`details.option = "--output"`） |
| `--model <id>` | `AGNES_IMAGE_MODEL` | |

**请求体构造**（严格照此，字段位置错了会 400）：
```json
{
  "model": "agnes-image-2.5-flash",
  "prompt": "...",
  "size": "4K",
  "ratio": "1:1",
  "extra_body": {
    "image": ["data:image/png;base64,..."],
    "response_format": "url"
  }
}
```
- `extra_body.image` **仅在 `--ref` 非空时出现**（空数组不要发）
- **禁止**发 `tags: ["img2img"]`（文档明确会报错）
- `ratio` 仅在 `size` 是档位时发

**data（成功）**：
```js
{
  path, bytes, model, size /* 真实像素 WxH，sharp 解出 */, requested /* 请求的 size 原样 */,
  ratio, mode /* "t2i" | "i2i" */, keyIndex, requestId, taskId,
  ...(refUrls === undefined ? {} : { refUrls }),   // 按序回显，data URI 只回 "data:<mime>;base64,<长度>bytes" 摘要，绝不回原文
  ...(sourceUrl === undefined ? {} : { sourceUrl })
}
```
- `mode` 判定：有 ref → `"i2i"`，否则 `"t2i"`；可交叉验证 `sourceUrl` 里的 `/images/i2i/` vs `/images/t2i/` 路径段
- ⚠️ `refUrls` 回显时**必须把 data URI 截断成摘要**，否则 base64 会灌爆 stdout 且可能泄漏图片内容
- 真实像素 ≠ 请求档位对应像素时 → `ctx.warnings.add({ code:"E_SIZE_MISMATCH", message, plugin:"agnes" })`。注意：请求 `4K` 时「期望像素」无法本地推算（依赖 ratio 与 16 对齐），因此**只在 `--size` 传了显式 `WxH` 时做比对并告警**；档位模式改为把实测像素如实写进 `data.size` 即可，不告警

**错误映射**：401/403 且全池失败 → `E_PROVIDER_ERROR`（`details.source:"agnes"`, `keyCount`, `attempts[]`）；400 → `E_PROVIDER_ERROR`（`details.status:400`, `details.message` 摊平后的人话, `details.requestId`）；响应 JSON 无法解析 → `E_PROVIDER_ERROR`（`details.reason:"malformed"`）；下载结果 URL 失败 → `E_PROVIDER_ERROR`（`details.source:"agnes"`, `details.stage:"download"`）。
**下载结果 URL 时不带 Authorization**（输出域是 `platform-outputs.agnes-ai.space`，与 apihub 不同域；沿用 modelscope 的做法）。

### 3.5 命令契约：`agnes-video`

> ⚠️ **执行顺序硬性要求**：先做 §6 的 **V0 探测**，把探测结论写进本节实现，**再**写代码。探测未通过的字段不得写进 README/SKILL（标 `待实测`）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--prompt <text>` | 必填 | 长度上限**待实测**，探测前不做本地预检（只做非空校验） |
| `--mode <text\|keyframe\|reference>` | 自动推断 | 推断规则：有 `--first-frame` → `keyframe`；有 `--images`/`--audios` → `reference`；否则 `text`。显式传值优先 |
| `--seconds <n>` | `5` | 整数 4–12，本地校验；**提交时转成字符串** `"5"`（文档明确是字符串） |
| `--aspect-ratio <r>` | `16:9` | 6 档枚举 |
| `--size <s>` | `720P` | **只允许 `720P`**，其他值本地 `E_INVALID_OPTION`（省下必然的 400） |
| `--first-frame <url>` / `--last-frame <url>` | — | 公网 URL；本地路径 → `E_INVALID_OPTION`（提示先 `tencent-cos-upload`）；`keyframe` 模式必须成对，缺一 → `E_MISSING_ARGUMENT` |
| `--images <url...>` | — | 公网 URL，**最多 5 个**（本地拦） |
| `--audios <url...>` | — | 公网 URL，**最多 3 个**（本地拦） |
| `--seed <n>` | — | 整数 |
| `--output <path>` | `agnes-video-<ISO时间戳>.mp4` | |
| `--no-wait` | — | 只提交不轮询，`data = { taskId, mode, ... }`（沿用 `suno-music` 的 `args.wait === false` 判定） |
| `--model <id>` | `AGNES_VIDEO_MODEL` | |

**禁止**接受 `--videos`（provider 明确不支持），manifest 里不要声明这个选项。

**轮询**：`GET {base}/agnesapi?video_id=<id>&model_name=<model>`（**路径待 V0 确认**）。判定：`status === "completed"` → 取**顶层 `url`**；`status === "failed"` 或存在非空 `error` → `E_PROVIDER_ERROR`；**忽略** `internal_status` / `internal_progress`。轮询间隔 `AGNES_POLL_INTERVAL_MS`，总 deadline `AGNES_TIMEOUT_MS`。

**data（成功）**：`{ path, bytes, model, taskId, mode, seconds, size, aspectRatio, status, sourceUrl, keyIndex, requestId }`

### 3.6 测试清单

新增 `tests/e2e/helpers/agnes-mock.ts`，**照抄 `modelscope-mock.ts` 的结构**：
- `startMock(behavior)`：`createServer` 绑 `127.0.0.1:0`，记录 `{ method, path, key, body }` 到 `mock.requests`；`behavior(req, endpoint)` 返回 `{ status, body }`；哨兵值 `body === "PNG"` → 回 `PNG_BYTES` + `content-type: image/png`（video 用 `"MP4"` 哨兵）
- 导出 `REAL_PNG`（真 8x16 PNG base64，用于验证 `data.size` 报真实像素）
- `agnesEnv(endpoint, extra)`：
  ```ts
  return {
    AGNES_BASE_URL: endpoint,
    AGNES_API_KEY: "ag-test-secret-key",
    AGNES_KEY_POOL: undefined,        // ← 关键：删掉继承来的真池（cli.ts 里 undefined = 从环境删除）
    AGNES_IMAGE_MODEL: "agnes-image-2.5-flash",
    AGNES_VIDEO_MODEL: "agnes-video-2.5-flash",
    AGNES_TIMEOUT_MS: "5000",
    AGNES_MAX_RETRIES: "2",
    ...extra,                          // extra 最后展开，池用例可覆盖
  };
  ```
  ⚠️ **本机 `~/.zshrc` 会有真 agnes key**，e2e 必须用假 key 覆盖并删掉 `AGNES_KEY_POOL`，否则会打真云、真扣费。（这正是 media-20 踩过的坑）

`tests/e2e/agnes-image.e2e.test.ts` 必须覆盖：
1. 文生图成功 → `data.path` 存在、`data.mode === "t2i"`、mock 收到 `POST /v1/images/generations`
2. 本地文件 `--ref` → 断言 mock 收到的 `body.extra_body.image[0]` 以 `data:image/png;base64,` 开头，且 `data.mode === "i2i"`
3. 公网 URL `--ref` → 原样透传
4. `--ref` 7 个 → `E_INVALID_OPTION` 且 `mock.requests` 长度为 0（**验证不发网络**）
5. prompt 10001 字符 → `E_INVALID_OPTION` 且不发网络
6. `--size 8K` → `E_INVALID_OPTION` 且不发网络
7. 503 一次后 200 → 成功，且 `mock.requests` 长度 2（证明重试）
8. 503 持续 → `E_PROVIDER_ERROR`，`details.reason === "queue_full_exhausted"`，且**只用了同一把 key**（断言所有 request 的 `key` 相同）
9. 400 → `E_PROVIDER_ERROR`，`details.status === 400`，不重试（requests 长度 1）
10. key 池：第一把 401、第二把 200 → 成功且 `data.keyIndex === 1`
11. 显式 `--size 2048x1152` 而 mock 回 `REAL_PNG`（8x16）→ 附 `E_SIZE_MISMATCH` 警告
12. `expect(r.stdout + r.stderr).not.toContain("ag-test-secret-key")`
13. base64 参考图时 `data.refUrls[0]` 是摘要不是原文（断言不含 `base64,` 之后的长串）

`tests/e2e/agnes-video.e2e.test.ts`：提交+轮询成功、`--no-wait` 只提交、`size != 720P` 本地拦、`images` 6 个本地拦、本地路径 `--images` → `E_INVALID_OPTION`、轮询 `status: "completed"` 时从**顶层 `url`** 取值（mock 同时给 `internal_status: "pending"` 证明它被忽略）。

`tests/unit/agnes.test.ts`：直接 import `lib/env.mjs` / `lib/refs.mjs` / `lib/error-text.mjs` 的纯函数——`loadConfig` 各缺变量分支、`AGNES_BASE_URL` 带 `/v1` 被裁掉、`parseKeys` 池优先、`toDataUri` 的 MIME 推断（png/jpg/webp）、`describeFailure` 对 `{error:{message}}` / `{detail}` / 纯字符串三种形态的摊平。

### 3.7 验收命令

```bash
pnpm lint && pnpm build && pnpm test
# 真实链路（各跑一次，确认非 mock 也能通）：
node dist/media-cli.js --json agnes-image --prompt "一只红苹果放在白桌上，柔和自然光" --output /tmp/ag-real.png
node dist/media-cli.js --json agnes-image --prompt "保持构图与光照，把苹果换成蓝色玻璃材质" \
  --ref /tmp/ag-real.png --size 1K --output /tmp/ag-edit.png
# 确认第二张真的走了编辑：data.mode 应为 i2i，sourceUrl 路径含 /images/i2i/
```

### 3.8 禁止事项

- 不要在 `index.mjs` 顶层读 `process.env` 或 import sharp（sharp 走 `loadSharp()` 懒加载 → `E_MISSING_DEPENDENCY`）
- 不要新增错误码；不要用未登记的 code（会被 `asCodedError` 静默降级成 `E_INTERNAL`）
- 不要 `process.exit`、不要写 `process.stdout/stderr`（只用 `ctx.logger` 与 `ctx.warnings`）
- 不要把 key 写进仓库任何文件（含本计划、测试 fixture、README）
- 不要在 e2e 里打真云（必须走 `AGNES_BASE_URL` mock）
- 不要把 base64 原文回显进 `data`

---

## 4. commit media-22 — `modelscope-image-fast`

### 4.1 改动清单

| 文件 | 动作 |
|---|---|
| `plugins/modelscope-image/lib/run.mjs` | **新建**。把 `index.mjs` 里 `modelscopeImageGen` 的主体流程抽成 `runImageGen(ctx, args, defaults)`，`defaults = { modelVar, modelFallback, stepsDefault, guidanceDefault, guidanceMin, filePrefix }` |
| `plugins/modelscope-image/lib/env.mjs` | 加 `MODELSCOPE_FAST_MODEL`（默认 `Qwen/Qwen-Image-2.1-Turbo`）；`loadConfig` 增返 `fastModel` |
| `plugins/modelscope-image/index.mjs` | 变成两个薄 handler + manifest 加一条 command。**目标 ≤280 行**（当前 251），若超了就按 `doubao` 风格把两个 handler 挪进 `lib/commands.mjs` |

⚠️ **抽取 `runImageGen` 是本 commit 唯一的破坏性风险点**。要求：抽取后现有 4 个 e2e 文件（`modelscope-image`、`-errors`、`-pool`、`-ref`）**一行都不改且全部通过**，否则说明抽错了，回滚重来。

### 4.2 命令契约：`modelscope-image-fast`

与 `modelscope-image-gen` **选项完全一致**，只有默认值不同：

| 项 | `modelscope-image-gen` | `modelscope-image-fast` |
|---|---|---|
| 模型 | `MODELSCOPE_IMAGE_MODEL`（无默认，缺 → `E_CONFIG`） | `MODELSCOPE_FAST_MODEL`，默认 `Qwen/Qwen-Image-2.1-Turbo` |
| `--steps` 默认 | 不传（provider 默认） | **8** |
| `--guidance` 默认 | 不传 | **1** |
| `--size` 默认 | `1024x1024` | **`2048x2048`**（用户要最大尺寸；实测每边上限 2048） |
| 输出文件名前缀 | `modelscope-` | `modelscope-fast-` |

**同时必须改的两处**（两个命令共用）：
1. `--guidance` 下限 `1.5` → **`1`**（`index.mjs:136` 与选项描述 `index.mjs:235` 都要改）。理由：Turbo 官方默认 CFG=1
2. prompt 长度**本地预检 4000 字符** → 超限 `E_INVALID_OPTION`（`details: { option:"--prompt", limit:4000, actual }`）。实测网关硬拦，本地预检省额度

### 4.3 测试

`tests/e2e/modelscope-image-fast.e2e.test.ts`（复用现成 `helpers/modelscope-mock.ts` 的 `msEnv`）：
1. 断言 mock 收到的 `body.model === "Qwen/Qwen-Image-2.1-Turbo"`、`body.steps === 8`、`body.guidance === 1`、`body.size === "2048x2048"`
2. `--guidance 1` 被接受（回归保护：改下限前这会 `E_INVALID_OPTION`）
3. `--guidance 0.9` → `E_INVALID_OPTION`
4. prompt 4001 字符 → `E_INVALID_OPTION` 且 `mock.requests` 长度 0
5. prompt 4000 字符（用汉字，验证按字符不按字节）→ 通过并发网络
6. `MODELSCOPE_FAST_MODEL` 覆盖生效
7. `--model` 覆盖生效
8. 对 `modelscope-image-gen` 补一条 prompt 4001 → `E_INVALID_OPTION` 的用例（预检是共用的）

`tests/unit/`：`parseNumberOption` 的 guidance 新下限边界（1 通过 / 0.999 拒绝）。

### 4.4 验收

```bash
pnpm lint && pnpm build && pnpm test
node dist/media-cli.js --json modelscope-image-fast --prompt "一只红苹果" --output /tmp/ms-fast.png
# 期望：data.size === "2048x2048"，耗时约 25-30s
```

---

## 5. commit media-23 — `media-face-cover`（白圆遮脸）

### 5.1 目录与文件清单

```
plugins/media-image/
  swift/vision-faces.swift      # 新建（单文件，参考 media-cutout/swift/vision-cutout.swift）
  lib/faces-bin.mjs             # 新建：FACE_BIN 覆盖 + sha256 命名缓存 + swiftc 编译（抄 media-cutout/lib/config.mjs:54-95）
  lib/detect-faces.mjs          # 新建：execFile 跑 Swift，解析 stdout JSON，stderr "E:*" → E_PROVIDER_ERROR
  lib/face-cover.mjs            # 新建：圆几何换算 + SVG 构造 + sharp composite + 输出编码
  index.mjs                     # 加一条 command + 一个薄 handler（当前 228 行，加完约 260，仍 <300）
```

### 5.2 Swift 工具契约（`swift/vision-faces.swift`）

用法：`vision-faces <input>`
stdout：**一行 JSON**
```json
{"width":1024,"height":768,"faces":[{"x":120.5,"y":88.0,"w":210.0,"h":210.0,"confidence":0.99,"quality":0.87}]}
```
失败：stderr 输出 `E:<message>`，exit 3（Node 端映射 `E_PROVIDER_ERROR`，`details.source = "vision"`）。

实现要点（**坐标换算是头号 bug 源，照抄**）：
1. `CIImage(contentsOf: url, options: [.applyOrientationProperty: true])` —— 让 CIImage 应用 EXIF 方向
2. `let extent = ciImage.extent`；`W = extent.width`，`H = extent.height`（这是**已摆正**的尺寸）
3. `VNImageRequestHandler(ciImage: ciImage, options: [:])`
4. `VNDetectFaceRectanglesRequest()`；`try? { req.revision = VNDetectFaceRectanglesRequestRevision3 }()`（Revision3 对侧脸更稳；老系统不支持就忽略）
5. `try handler.perform([req])`
6. 对每个 `VNFaceObservation`：`bb = obs.boundingBox`（**归一化 + 左下原点**）→ 换算：
   ```
   x = bb.minX * W
   y = (1.0 - bb.maxY) * H      // ← 翻转 Y：Vision 左下原点 → 图像左上原点
   w = bb.width * W
   h = bb.height * H
   ```
7. `confidence = Double(obs.confidence)`；`quality = obs.faceCaptureQuality.map(Double.init)`（可空）
8. 用 `JSONSerialization` 输出，`exit(0)`
9. 编译：`swiftc -O -target arm64-apple-macos14.0 <src> -o <tmp> && mv`（先写临时再 rename 保证原子）

### 5.3 命令契约

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <path>` | 必填 | 图片文件或文件夹（**注意是 `--input`**，与 `media-image` 其他命令一致，才能复用 `runBatch`） |
| `--output <path>` | 单文件 `<name>.covered.<ext>`；文件夹 `./face-cover/` | 走 `defaultSidecar(input, "covered")` |
| `--scale <n>` | `1.2` | 内切圆放大倍数，范围 0.5–3.0 |
| `--at <x,y,r>` | — | **可重复**。人工指定圆（像素、左上原点），与 Vision 检测结果**合并**；用于侧脸/漏检兜底 |
| `--min-confidence <0-1>` | `0.3` | 低于此置信度的脸不遮 |
| `--color <hex>` | `#FFFFFF` | 复用 `lib/options.mjs` 的 `COLOR_RE` 校验 |
| `--recursive` | — | 文件夹递归（复用 `runBatch`） |

**圆几何**：`r = (min(face.w, face.h) / 2) * scale`，`cx = face.x + face.w / 2`，`cy = face.y + face.h / 2`。圆超出画布不裁剪（SVG 自动裁），但要 clamp `cx/cy` 到画布内以免整圆跑到图外。

**渲染**：
```js
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
  circles.map(c => `<circle cx="${round2(c.cx)}" cy="${round2(c.cy)}" r="${round2(c.r)}" fill="${color}"/>`).join("") +
  `</svg>`;
await sharp(input).rotate().composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .toFormat(format, formatOptions).toFile(output);
```
- **`.rotate()` 必须在 `.composite()` 之前**（sharp 管线顺序固定）——这样 JS 侧也摆正 EXIF，与 Swift 侧的 `applyOrientationProperty` 坐标系一致
- 输出格式沿用原图格式（`resolveImageFormat`），jpg 走 `quality`（默认 与 `media-compress` 一致）
- `circles` 为空时**不做 composite**，直接原样重编码输出（省一次无意义合成）

**data（单文件）**：
```js
{ path, bytes, width, height, covered /* 圆数量 */,
  faces: [{ x, y, r, confidence, source: "vision" | "manual" }] }
```
**data（文件夹）**：`{ outputDir, results: [...], failed: [{file, reason}], total }`（`runBatch` 既有形状）

**失败语义**：
- 0 张脸且无 `--at` → 输出原图副本 + `ctx.warnings.add({ code: "E_NO_FACE_DETECTED", message, plugin: "media-image" })`，**exit 0**
- swiftc 缺失 / 非 macOS / 编译失败 → `E_MISSING_DEPENDENCY`（`details: { dependency:"swiftc", hint:"xcode-select --install" }`）
- Swift 进程 exit≠0 → `E_PROVIDER_ERROR`（`details.source:"vision"`，stderr 的 `E:` 文本进 `message`）
- **但**：只要传了 `--at`，即使 Swift 不可用也应能工作 → 实现上：`--at` 非空时把 Vision 检测降级为「失败则警告 `E_MISSING_DEPENDENCY` 继续」，与 `media-av` 的 ffmpeg drawtext 降级先例一致
- 单张失败（文件夹模式）→ 记入 `data.failed` 继续其余

### 5.4 测试

- `tests/unit/face-cover.test.ts`：圆几何换算（`scale` 边界、clamp 到画布）、`--at` 解析（`"10,20,30"` → `{x,y,r}`；格式错 → `E_INVALID_OPTION`）、`--min-confidence` 过滤、Swift JSON 解析（含空 faces、含非法 JSON）
- `tests/e2e/media-face-cover.e2e.test.ts`：
  1. **不依赖 Vision 的确定性用例**：用 sharp 合成一张 200x200 灰图，`--at 100,100,40`，断言输出图 `(100,100)` 像素是白色、`(10,10)` 仍是灰 → 这条是主力回归保护
  2. `--at` 格式非法 → `E_INVALID_OPTION`
  3. 不支持的扩展名（`.gif`）→ `E_INVALID_OPTION`
  4. 文件夹批量 → `data.outputDir` + `total`，且默认输出目录不被二次枚举（`excludeUnder` 已处理）
  5. Vision 路径：跑一张**真人脸 fixture**（若仓库无此 fixture，用 `--at` 代替并在测试注释里写明「Vision 真实检出需手工验证」）
- **手工验证（必做，写进 commit message）**：拿一张真实含人脸的照片跑一次，肉眼确认白圆盖住脸、位置没偏（EXIF 方向、Retina、竖拍各试一张）。这是坐标系换算唯一的可靠验证手段

---

## 6. commit media-24 — `doubao-grid-locate` + `media-grid-caption`

### 6.0 V0 探测（在执行 media-21 的 agnes-video 之前先做，结论回填 §1.2）

用 `~/.zshrc` 里已配好的 `AGNES_API_KEY` 跑：

```bash
source ~/.zshrc   # 或直接从 .zshrc 取 AGNES_API_KEY
# V0-1: text 模式最小用例（确认提交响应体与 task id 字段名）
curl -s -X POST "$AGNES_BASE_URL/v1/videos" -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agnes-video-2.5-flash","prompt":"a red cube rotating on white background","mode":"text","seconds":"4","size":"720P","aspect_ratio":"1:1"}'
# V0-2: 用上一步返回的 id 试轮询路径（两种都试，看哪个通）
curl -s "$AGNES_BASE_URL/agnesapi?video_id=<ID>&model_name=agnes-video-2.5-flash" -H "Authorization: Bearer $AGNES_API_KEY"
curl -s "$AGNES_BASE_URL/v1/videos/<ID>" -H "Authorization: Bearer $AGNES_API_KEY"
# V0-3: 验证 400 形态与优先级（size 非 720P）
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$AGNES_BASE_URL/v1/videos" -H "Authorization: Bearer $AGNES_API_KEY" \
  -H "Content-Type: application/json" -d '{"model":"agnes-video-2.5-flash","prompt":"x","mode":"text","size":"1080P"}'
# V0-4: reference 模式 + 5 张 images（用 agnes-image 产出的公网 URL）
# V0-5: keyframe 模式 + first_frame/last_frame
```

**必须记录并回填 §1.2 的项**：提交响应体字段名、真正能用的轮询路径与是否需要 auth、`status` 的取值集合、`detail` 错误的真实形态、一条 4s/720P 视频的真实耗时、5 张 images 是否真被接受。
**探测失败的项**：README/SKILL 里写 `待实测`，**不许编数字**。

### 6.1 `doubao-grid-locate`（`plugins/doubao/`）

新增文件：
```
plugins/doubao/lib/grid-locate.mjs    # handler：读图 → base64 → 组 messages → chatWithRetry → 抽 JSON → 校验 → data
plugins/doubao/lib/grid-prompt.mjs    # 系统/用户 prompt 文本（单独一个文件，便于调 prompt 不动逻辑）
plugins/doubao/lib/grid-schema.mjs    # cells JSON 的解析（剥 ```json 围栏）+ §2 的校验规则
```
`plugins/doubao/lib/config.mjs`：加 `export const VISION_MODEL_VAR = "DOUBAO_VISION_MODEL";`，`getConfig` 增返 `visionModel: (env.DOUBAO_VISION_MODEL ?? "").trim() || null`（**照抄现有 `model` 的写法，不内置默认值**）。
`plugins/doubao/index.mjs`：加一条 command（当前 57 行，加完约 77 行）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <path>` | 必填 | 单张图片（**只支持单文件**，目录 → `E_INVALID_OPTION`） |
| `--model <id>` | `DOUBAO_VISION_MODEL` | 两者都缺 → `E_CONFIG`（`details.var = "DOUBAO_VISION_MODEL"`） |
| `--expected <n>` | — | 可选，提示模型期望格数（4/6/8/9…），写进 prompt；**实际检出格数与它不符时附 `E_CELL_COUNT_MISMATCH` 警告**（不失败：模型可能确实找到别的格数） |
| `--max-side <n>` | `1568` | 送模型前把图片**最长边**缩到 n 以内（范围 256–4096，越界 → `E_INVALID_OPTION`）。图本来就够小则原图直送（`data.scale = 1`、无 `data.sent`） |
| `--output <path>` | — | 可选，把 data 写成 JSON 文件（方便直接喂给 `media-grid-caption --cells`）；缺省只在 stdout 的 `data` 里 |

实现要点：
- **必须先降采样再 base64**（F1，实测结论）：原图直送是整条流水线最大的可靠性问题 —— 6.6MB PNG 变成 ~8.8MB 请求体，单页实测 239s / 88s，两路并发全在 `DOUBAO_TIMEOUT_MS` 上双双 `E_PROVIDER_ERROR / reason:"timeout"`。缩到长边 1568 后请求体降到百 KB 级。
  降采样只改**送给模型的那张图**：§2 的 `cells[].x/y/w/h` 与 `image.width/height` 一律是**原图像素**。
  做法：`sharp().resize({width:maxSide,height:maxSide,fit:"inside",withoutEnlargement:true})` → 记下 `sx/sy` →
  按（缩小图的）尺寸做 §2 校验 → 再 `x/sx`、`w/sx`、`y/sy`、`h/sy` 放大回原图（取整溢出 1px 的按原图边界内收并记 `notes`）。
  prompt 里同时写清「图由 `OWxOH` 原图缩小到 `WxH` 送给你，坐标基于你看到的这张 `WxH` 图」，否则模型会去猜原图像素。
  `data.scale`（1 = 未缩）与 `data.sent`（`{maxSide,width,height,sx,sy,bytes,originalBytes}`）把这次缩放留在可审计的位置；`--output` 落盘的文件仍是纯 §2 四字段。
  sharp 不可用/缩完反而更大 → 原图直送并写 `data.notes`，绝不因为缩图失败打断命令。
- 图片走 `data:<mime>;base64,` data URI，放 `messages[0].content[]` 的 `{ type:"image_url", image_url:{ url: <dataUri> } }`，文本部分 `{ type:"text", text: <prompt> }`（`plugins/doubao/lib/audio.mjs:81` 已有 base64 先例可参考）
- prompt 必须要求：**只输出 JSON，不要解释、不要 markdown 围栏**；cells 按阅读顺序（左→右、上→下）编号；坐标为**像素、左上原点**；必须给 `image.width/height`
- 解析：先剥 ```` ```json ```` / ```` ``` ```` 围栏，再 `JSON.parse`；失败 → **重试一次**（追加一句「上次输出不是合法 JSON，只输出 JSON」）；再失败 → `E_PROVIDER_ERROR`（`details.reason:"unparsable_vision_output"`，`details.raw` 截断 800 字符）
- 校验：按 §2 的 5 条规则；VLM 常犯越界/归一化坐标（0–1 小数）→ 检测到所有 `w/h` 都 ≤ 1.5 时判定为归一化坐标，自动 × image 尺寸并在 `data.notes` 里说明（这是务实的容错，不是静默猜测）
- 复用 `chatWithRetry`，**不要另写 HTTP 层**
- `data` = §2 的 schema，`source: "vision"`，`model` 回填实际用的 id

### 6.2 `media-grid-caption`（`plugins/media-image/`）

新增文件：
```
plugins/media-image/lib/grid-detect.mjs    # 本地自动检测（兜底第二级）
plugins/media-image/lib/cells-io.mjs       # 读 + 校验 cells JSON（§2 规则）
plugins/media-image/lib/grid-caption.mjs   # 版式计算 + SVG 构造 + sharp composite + 兜底外扩
plugins/media-image/lib/text-layout.mjs    # 自动字号 + 自动换行（复用 watermark.mjs 的 measureText）
```
`index.mjs` 加一条 command（当前 228 + media-23 的约 30 = 约 258，再加本条约 30 → **会超 300**）。
→ **因此本 commit 必须把 `index.mjs` 的 handler 挪到 `lib/commands.mjs`**，`index.mjs` 只留 manifest（照 `suno-music/index.mjs` 的第二种房子风格）。挪完 `index.mjs` 应 ≤150 行。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <path>` | 必填 | 单张图片（**本命令不支持目录批量**：字幕文本与图一一对应，批量语义不清） |
| `--cells <path.json>` | — | §2 统一 schema（来自 `doubao-grid-locate --output` 或人工写） |
| `--captions <path.json>` | — | 只有文本+样式：`[{"index":0,"text":"...","fontSize":42,"align":"center"}]`；与 `--cells` **合并**（按 `index` 对齐） |
| `--cols <n>` / `--rows <n>` | — | 人工等分，跳过检测；两个必须同时给，否则 `E_INVALID_OPTION` |
| `--locate` / `--no-locate` | 开启 | 是否允许本地自动检测 |
| `--font <family>` | `sans-serif` | 字体**族名**（D33） |
| `--font-size <n>` | 自动 | 覆盖自动字号，6–1000 |
| `--text-color <hex>` | `#FFFFFF` | 走 `COLOR_RE` 校验 |
| `--opacity <0-1>` | `0.1` | 黑底不透明度（用户指定；很淡，亮底需自行调高）；`1` = 纯黑 |
| `--padding <n>` | `12` | 黑条内边距（像素） |
| `--position <bottom\|top>` | `bottom` | 格内黑条位置 |
| `--flat-tol <n>` | `12` | 自动检测：一行/列内 max-min ≤ 此值视为纯色带 |
| `--min-gutter <n>` | `3` | 自动检测：纯色带最小厚度（像素） |
| `--allow-overlap` | 关闭 | 放行 §2 规则 6 的格子重叠（默认 `E_INVALID_OPTION`；只有刻意的分层版式才需要） |
| `--output <path>` | `<name>.captioned.<ext>` | `defaultSidecar(input, "captioned")` |

**字幕文本来源**：只有 `--cells` / `--captions` 两个 JSON 入口（用户选定）。两者都没有 → `E_MISSING_ARGUMENT`（提示可用 `doubao-grid-locate` 生成）。
条数不匹配：**合并后只发一条 `E_PARTIAL_INPUT` 警告**（`cells-io.mjs` 的 `describePartialInput()` 负责措辞），
一条消息里同时讲清两件事——哪些格没有文本（`missingCells` 的 index）与哪些字幕找不到对应格（`droppedIndexes` 的 index）。
**都不失败**。历史 bug（F6）：两句分别按「匹配到的条数」和「未匹配的条数」计数，于是 4 格 + 3 条有效 + 1 条坏 index
会同时输出「字幕条数（3）少于格数（4）」与「字幕条数多于格数：有 1 条…已忽略」两条互相矛盾的警告。

**定位三级优先级（D32）**：
1. `--cells`（`source: "manual"` 或沿用 JSON 里的 `source`）→ 直接用
2. `--cols`/`--rows` → 等分切（`source: "manual"`）
3. `--locate` 本地自动检测（`source: "auto"`）
4. 全失败 → **兜底版式**（见下）

**本地自动检测算法（`lib/grid-detect.mjs`）—— 只覆盖「分隔线对齐的规则宫格」**：

> ⚠️ **真实样本实测结论（2026-10-14，`04剧情产物/病栋小路由/分镜v3/S019.png`，2048x2048）**：该页是 9 格分镜，但**面板带 1–3° 倾斜、相邻格边界互相错开、格宽不等**。因此「整行纯色即分隔线」这类严格判据**必然失效**（倾斜的黑描边会横穿每一条候选分隔线）。真实分镜页的定位**必须走 `doubao-grid-locate`（视觉模型）**，本地检测只作为规则宫格（如 `media-filmstrip` 产物、等分拼图）的兜底。写文档时不得宣称"本地检测支持不规则宫格"。

```
输入：sharp(input).rotate().greyscale().raw() → { data, info:{width,height} }
1. 选背景/分隔带取色（**候选打分**，不是单点估计）：候选色 = 四边各 edgeBand(8) 条带的中位数 →
   四边条带众数 → 全图灰度直方图 Top-8；对每个候选算「该色构成的整行数 + 整列数」（占比 >= 1-crossFrac），
   取覆盖率高者优先试，第一个通过全部校验的候选即当选。
   —— 只按「四边中位数」取色会在**满幅宫格**（内容顶到图片边缘、只靠格间细缝分隔）上取到内容色，
   于是每块都被当成背景 → single_band 拒绝检出（实测 512x512 的 2x2 无外边距宫格）；
   分隔带颜色未必等于边框颜色，但**它一定构成笔直的整行/整列**，这就是打分的依据。
   放大 --flat-tol 救不了这类图：错的是选色不是容差。
2. 逐行扫描：bgFrac[y] = 该行中与 bg 的 |Δ| <= bgTol 的像素占比
   逐列扫描：bgFrac[x] 同理
   —— 用「占比」而不是「整行 max-min」，才能容忍倾斜描边横穿分隔线
3. 分隔带 = bgFrac >= 1 - crossFrac 的连续段，丢弃厚度 < minGutter 的段
   （最外圈边框也是分隔带，一并收下，统一处理有/无边框两种情况）
4. 行内容带 = 相邻分隔带之间；列同理
5. 拒绝条件（任一命中即返回 null，走兜底版式）：
   - 行内容带数 < 1 或 列内容带数 < 1
   - 行带数 × 列带数 === 1（整图是单色，不是宫格）
   - 行带数 × 列带数 > 64（多半是误检）
   - **格尺寸合理性校验**：任一候选格的 `w` 或 `h` 小于 `max(2×minGutter, 短边×0.04, 最厚的一条分隔带)`
     → 判 `cells_too_small`。拿内容色当背景时格间细缝会变成仅有的内容带，产出的假格比分隔带本身还窄；
     「满幅且九格同色」这类图正是靠这条 + 上面的候选打分才不会被误检、也不会被漏检
   - **对齐性校验**：对笛卡尔积得到的每个候选格，量它内部的非背景占比；
     只要有任一候选格的非背景占比 < 0.35，说明行列边界不匹配真实格边界
     （即倾斜/错位的 irregular 宫格）→ **换下一个候选背景色重试**，全部候选都失败才整体判为检测失败
6. 通过则 cells = 行带 × 列带 笛卡尔积，按阅读顺序（先 y 后 x）编 index
7. 返回 { cells, confidence, background }；confidence = 各候选格非背景占比的最小值，
   background = 最终当选的取色（排查「为什么检不出/检错」时最有用的一个数）
```
默认阈值：`bgTol = 24`、`crossFrac = 0.06`（允许 6% 的像素横穿分隔线）、`minGutter = 3`、
`bgCandidates = 8`、`minCellFrac = 0.04`。全部候选都落选时，报**打分最高**（最像背景）那个候选的失败原因。
对「每格都是照片、无纯色分隔线」的图会检测失败 → 走兜底，这是正确行为。

**正常版式（每格）**：
- 用 `text-layout.mjs` 算：给定格宽 `w`、`padding`，二分/递减找最大 `fontSize`（起点 `autoFontSize(w, h)`，下限 14）使 `measureText` 的宽 ≤ `w - 2*padding`；超宽则按字符折行，行数上限 4 行，再多则截断加 `…` 并附 `E_TEXT_TRUNCATED` 警告
- 每格字号的优先级：`cells[].fontSize`（§2 的每格覆盖值）> `--font-size`（全局覆盖）> 自动档。
  修正记录：`cells[].fontSize` 以前只被校验、没被送进布局计算（等于静默丢弃），现在三档都生效
- 黑条高度 = `行数 * 行高 + 2 * padding`，`行高 = fontSize * 1.35`
- 位置：`position === "bottom"` → 贴着格底边；`"top"` → 贴着格顶边。**不超出该格边界**（clamp 到 cell 内）
- 一个 `<svg>` 画完整图尺寸，内含 N 个 `<rect fill="#000000" fill-opacity="${opacity}">` + 对应 `<text fill="${textColor}">`，**所有用户文本必须过 `escapeXml`**
- `sharp(input).rotate().composite([{ input: svgBuffer, top: 0, left: 0 }])` → 输出，**整图尺寸不变**

**兜底版式（`data.layout = "fallback-bottom"`）**：
- 在整图**底部向外扩**一条黑边（`sharp.extend({ bottom: barHeight, background: { r:0,g:0,b:0,alpha:1 } })` 后再 composite，或用 `extract`+`composite` 到新画布）
- `barHeight = 行数 * 行高 + 2 * padding`，行数是**所有字幕逐行堆叠**的总行数（每条字幕一行，按 `index` 顺序；单条过长则按整图宽折行）
- 半透明黑底 `fill-opacity: opacity`（用户明确说「同样是半透明黑底白色文字」），白字居中，字号自动（按整图宽）
- 输出图**变高**：`data.width/height` 报输出后的尺寸，`data.originalHeight` 报原高
- 附警告 `{ code: "E_GRID_NOT_DETECTED", message: "未能定位宫格（视觉模型不可用且本地检测失败），字幕已外扩到整图底部", plugin: "media-image" }`，**exit 0**

**data**（= 选项回显 `input/font/fontSize/textColor/opacity/padding/position` 加上面产出的字段）：
```js
{
  path, bytes, width, height,                       // 输出图的真值（兜底版式时是变高后的尺寸）
  layout: "in-cell" | "fallback-bottom",
  source: "vision" | "auto" | "manual" | "none",    // none = 三级定位全失败（只出现在输出）
  cells: n,                                          // 格子数（兜底版式恒为 0）
  bars: n,                                           // 实际画出的黑条数（in-cell）/ 1（兜底）
  lines: n,                                          // 实际画出的文本行数
  truncated: n,                                      // 被截断加 … 的条数（哪几格写进 E_TEXT_TRUNCATED 的 message）
  minFontSize, maxFontSize,                          // 实际画出来的字号聚合口径（无条时 null）
  fontSizePerCell: [{ index, fontSize }],            // 仅 in-cell：每格真实字号；F7 的正解，别再用最小值冒充
  captions: n,                                       // 仅兜底版式：堆叠的字幕条数
  originalHeight: n,                                 // 仅兜底版式：外扩前的原高
  empty: true                                        // 一行都没画时才有
}
```
⚠️ `fontSize` 这个字段名只用于**回显 `--font-size` 选项**（没传就是 `null` = 自动档，与 `media-watermark` 同语义）；
「实际画出来的字号」一律看 `fontSizePerCell` / `minFontSize` / `maxFontSize`。

### 6.3 测试

- `tests/unit/grid-detect.test.ts`：纯函数喂手工构造的灰度矩阵——2x2 白带宫格 → 4 格且坐标正确；3x3 → 9 格；不等宽的两列 → 2 格且 w 不等（**不规则用例**）；纯色整图 → null；无分隔线的渐变图 → null
- `tests/unit/cells-io.test.ts`：§2 的 5 条校验规则各一条用例（越界、w=0、index 重复、image 尺寸不符、cells 空数组）；归一化坐标自动放大 + `data.notes`
- `tests/unit/text-layout.test.ts`：长文本折行、4 行截断、fontSize 下限
- `tests/e2e/media-grid-caption.e2e.test.ts`：
  1. 用 sharp 合成一张 **2x2 规则宫格 fixture**（4 个不同色块 + 8px 白色 gutter，总 512x512）→ 不带 `--cells` 直接跑，断言 `data.cells === 4`、`data.source === "auto"`、`data.layout === "in-cell"`、输出尺寸仍是 512x512
  2. `--cells` 人工传 4 格 + `--captions` → 断言每格底部黑条区域像素偏暗、中心仍是原色块
  3. **墨迹断言（D33 防 tofu）**：断言输出图中白字像素数 > 0
  4. 兜底：给一张无 gutter 的渐变图 + `--captions` → 断言 `data.layout === "fallback-bottom"`、输出高 > 原高、warnings 含 `E_GRID_NOT_DETECTED`、exit 0
  5. `--cells` 越界 → `E_INVALID_OPTION` 且 `details.cell` 有 index
  6. 字幕条数 < 格数 → warnings 含 `E_PARTIAL_INPUT`，exit 0
  7. `--opacity 1` → 黑条区域为纯黑（R=G=B=0）
  8. 文本含 `<script>` 与 `&` → 正常渲染不报错（验 `escapeXml`）
- `tests/e2e/doubao-grid-locate.e2e.test.ts`：mock `DOUBAO_BASE_URL`（**必须同时把继承的真 `DOUBAO_API_KEY` 覆盖成假 key**，本机 .zshrc 有真 key）：
  1. mock 回带 ```` ```json ```` 围栏的合法 cells → 解析成功、`data.source === "vision"`
  2. mock 回非法 JSON 一次、第二次回合法 → 成功且 `mock.requests` 长度 2
  3. 两次都非法 → `E_PROVIDER_ERROR`，`details.reason === "unparsable_vision_output"`
  4. 缺 `DOUBAO_VISION_MODEL` 且无 `--model` → `E_CONFIG`，`details.var === "DOUBAO_VISION_MODEL"`，不发网络
  5. `--input` 是目录 → `E_INVALID_OPTION`
  6. 断言 mock 收到的 body 里 `messages[0].content` 含 `image_url` 且以 `data:image/` 开头
  7. 断言输出不含真 key

### 6.4 手工验证（必做）

拿一张**真实的不规则宫格图**（例如 6 格漫画分镜）跑：
```bash
node dist/media-cli.js --json doubao-grid-locate --input grid.png --output cells.json
# 打开 cells.json 人工核对坐标，必要时手改
node dist/media-cli.js --json media-grid-caption --input grid.png --cells cells.json --captions subs.json
```
把实测的格数、是否检出正确、耗时写进 commit message 与 SKILL.md 坑位。**没跑过就不要在文档里写"支持不规则宫格"。**

---

## 7. commit media-25 — 文档与配置汇总

### 7.1 `~/.zshrc`

追加（**key 从 `~/.qoder/settings.json` 的 `providers` 里取 `baseUrl` 含 `agnes-ai.com` 的那把 `apiKey`；已实测该 key 可生图。写入时不要在终端回显、不要写进仓库任何文件**）：

```bash
# >>> media-cli agnes (agnes-image / agnes-video) >>>
export AGNES_BASE_URL="https://apihub.agnes-ai.com"      # 不带 /v1
export AGNES_API_KEY="<从 ~/.qoder/settings.json 取>"
export AGNES_KEY_POOL=""                                  # 可选：逗号分隔多把，设置后覆盖单 key
export AGNES_IMAGE_MODEL="agnes-image-2.5-flash"
export AGNES_VIDEO_MODEL="agnes-video-2.5-flash"
# <<< media-cli agnes <<<

# 追加到已有的 doubao 块内（# >>> media-cli doubao >>> ... # <<< 之间）
export DOUBAO_VISION_MODEL="doubao-seed-2-1-lite-260915"  # 宫格定位视觉模型（用户已验证可收图）

# 追加到已有的 modelscope 块内
export MODELSCOPE_FAST_MODEL="Qwen/Qwen-Image-2.1-Turbo"  # modelscope-image-fast 默认模型
```

用 `# >>> ... >>>` / `# <<< ... <<<` 包裹，与文件里 doubao / modelscope / tencent-cos 三个既有块的风格一致。**改 dotfile 前先 `cp ~/.zshrc ~/.zshrc.bak-<日期>`**，改完 `source ~/.zshrc` 验证 4 个变量都非空。

### 7.2 `skills/media-cli/SKILL.md`（4 处都要改）

1. **frontmatter `description`** 追加触发词（中英混合）：`agnes 生图`、`agnes 视频`、`agnes-image`、`agnes-video`、`图生视频`、`首尾帧`、`快速文生图`、`turbo 生图`、`modelscope-image-fast`、`遮挡人脸`、`遮脸`、`打码`、`白圆遮脸`、`face cover`、`宫格加字幕`、`九宫格字幕`、`分镜加字`、`grid caption`、`宫格定位`、`grid locate`
2. **命令速查表**加 5 行（`| 意图 | 命令 | 关键选项 |` 格式，照抄 `tencent-cos-upload` 那行的密度）
3. **环境变量表**加：`agnes-image` / `agnes-video`（4 个 AGNES_* + 池 + 超时）、`doubao-grid-locate`（`DOUBAO_API_KEY` + `DOUBAO_VISION_MODEL`）、`modelscope-image-fast`（`MODELSCOPE_FAST_MODEL`，可选）
4. **坑位与输出语义**加以下实测结论（每条一行，密集写）：
   - `agnes-image` 是**同步**接口；`--size` 用 `4K` 档才有最大尺寸（4K/1:1 = 4096x4096，4K/21:9 = 6272x2688）；**显式 `WxH` 会被降采样**（实测 2048x1152 → 1312x736），所以 `data.size` 报的是真实像素
   - `agnes-image` 的 i2i 会撞 **503 `image queue is full`**（1–3s 快速失败），已内置退避重试（`AGNES_MAX_RETRIES`，默认 6）；成功的 i2i 实测 **20–98s**，别把超时设太短
   - `agnes-image` 参考图上限 **6 张**，本地文件自动转 base64 data URI（**不需要上传 CDN**）；prompt 上限 **10000 字符**
   - `agnes-video` 参考图**只收公网 URL**（本地文件先 `tencent-cos-upload`），`images` 上限 **5**、`audios` 上限 **3**、`size` **只有 720P**、`seconds` 是字符串 `"4"`–`"12"`
   - `modelscope-image-gen` / `modelscope-image-fast` 的 prompt 上限是 **4000 字符**（网关硬拦，已本地预检），按**字符**计不按字节（4000 汉字可以）；每边 `[64,2048]`
   - `modelscope-image-fast` 默认 Turbo + `steps=8` + `guidance=1` + `2048x2048`，实测 2048² 约 25–30s；同 key **4 路并发**实测可用
   - ⚠️ **ModelScope 任务记录约 10 分钟就过期**（再查变 `task not found`），必须拿到就立刻下载，不要事后再拉 URL
   - `media-face-cover` 用 Apple Vision 本地检脸（离线、需 macOS + `swiftc`，首次运行编译并缓存）；**检不到脸不失败**，会输出原图副本 + `E_NO_FACE_DETECTED` 警告；侧脸漏检用 `--at x,y,r` 人工补
   - `media-grid-caption` 定位三级：`--cells` > `--cols/--rows` > 本地自动检测；全失败会把字幕**外扩到整图底部**（`data.layout = "fallback-bottom"` + `E_GRID_NOT_DETECTED` 警告），不会静默套错版式
   - `doubao-grid-locate` 的输出**就是** `media-grid-caption --cells` 的输入格式，可落盘人工改完再用
   - 保留既有那条兜底声明（`spec` 为准），不要删

5. **同步到生效副本**：改完仓库这份后必须再复制到 `~/.agents/skills/media-cli/SKILL.md`（生效的是那份独立副本，只改仓库不生效）

### 7.3 `README.md`

- 新增 `### agnes（Agnes 2.5 Flash 生图/生视频）` 段，放在 `### modelscope-image` 之后，严格照 `### azure-image` 那段的模板：```bash 示例块（含 `export`）+ `| 环境变量 | 默认 | 说明 |` 表 + 语义段落。示例要包含「本地文件直接当参考图（自动 base64，不用先上传）」这一条，因为这是与 modelscope 的关键差异
- `### modelscope-image` 段增补 `modelscope-image-fast` 的示例与 4000 字符/2048 上限
- `### media-image` 段增补 `media-face-cover` 与 `media-grid-caption`
- `### doubao` 段增补 `doubao-grid-locate` + `DOUBAO_VISION_MODEL`
- 实测数字段落带日期标注，照现有风格写「实测（2026-10-14）」

### 7.4 `package.json`

`description` 与 `keywords` 补上新能力关键词（既有插件加入时都同步过，照做）。

### 7.5 `docs/plans/00-master-plan.md`

只在**确实新增了错误码**时才改错误码表——按 D34 本阶段不新增，所以**不需要改**。若执行中发现非新增不可，必须同时改 `src/core/errors.ts` 与此表，并回来更新本文件的 D34。

### 7.6 验收

```bash
pnpm lint && pnpm build && pnpm test
# spec 的真实结构是扁平的 data.commands[]，每条带 source: "builtin" | "plugin:<name>"
node dist/media-cli.js --json spec | python3 -c "
import sys,json
d=json.load(sys.stdin)
want={'agnes-image','agnes-video','modelscope-image-fast','media-face-cover','media-grid-caption','doubao-grid-locate'}
got={c['name']: c['source'] for c in d['data']['commands']}
missing=sorted(want-set(got))
for n in sorted(want&set(got)): print(' OK  %-24s <- %s'%(n,got[n]))
print('MISSING:',missing) if missing else print('all 6 new commands present')
sys.exit(1 if missing else 0)"
grep -c 'agnes' skills/media-cli/SKILL.md          # > 0
diff skills/media-cli/SKILL.md ~/.agents/skills/media-cli/SKILL.md   # 应无差异（生效的是 ~/.agents 那份副本）
```

---

## 8. 待实测清单（执行时必须回填，禁止编造）

| # | 待实测项 | 怎么测 | 回填到 |
|---|---|---|---|
| V0 | agnes-video 全链路（提交响应体字段、真实轮询路径、status 取值集合、4s/720P 真实耗时、5 张 images 是否真被接受、keyframe 首尾帧） | §6.0 的 5 条 curl | §1.2 + README + SKILL |
| V1 | agnes-image 的 i2i 并发上限（探测期间队列一直满，未测出来） | 队列空闲时发 2/3/4 路并发 i2i | §1.1 + SKILL 坑位 |
| V2 | agnes-image `2K`/`3K` 档在 1:1 与 16:9 下的真实像素（验证「档位=面积、对齐 16」的推断） | 各跑一次，sharp 读真实像素 | §1.1 + README 档位表 |
| V3 | agnes-image `response_format: "b64_json"` 的真实响应形态（是否 `data[0].b64_json` 有值、`url` 是否为空串） | 跑一次 | §3.4 |
| V4 | agnes-image 参考图**单张体积/尺寸上限**（6 张已知，单张上限未知；4K 大图当参考图是否被拒） | 用 4096x4096 的 PNG 当 ref 跑一次 | §1.1 |
| V5 | `doubao-grid-locate` 在 4/6/9 宫格与不规则宫格上的真实检出率与耗时 | 各跑 2–3 张真实图 | SKILL 坑位 + README |
| V6 | `media-face-cover` 对侧脸/俯仰/小脸的检出情况，以及 `--scale 1.2` 是否够盖 | 真实照片手工验证 | SKILL 坑位（含建议 scale） |

---

## 9. 已知坑与风险（执行前通读）

1. **e2e 打真云**：本机 `~/.zshrc` 有真 `AGNES_API_KEY` / `MODELSCOPE_KEY_POOL` / `DOUBAO_API_KEY` / COS 凭据。所有新 e2e 必须显式覆盖成假值，并用 `undefined` 删掉继承来的池变量（`tests/e2e/helpers/cli.ts:22-25` 的语义）。media-20 就因为这个挂过三个用例
2. **坐标系**：Vision 的 `boundingBox` 是**归一化 + 左下原点**；本仓库所有像素坐标约定是**左上原点**。换算公式在 §5.2，别搞反 Y 轴
3. **EXIF 方向**：Swift 侧 `.applyOrientationProperty: true`，JS 侧 `.rotate()`，两边必须同时做，否则竖拍照片的白圆会偏移
4. **sharp 管线顺序**：`.rotate()` 必须在 `.composite()` 之前
5. **SVG 注入**：任何用户文本进 SVG 前必须过 `escapeXml`；颜色值必须过 `COLOR_RE`
6. **`--input` 不是 `--file`**：`media-image` 的命令一律用 `--input`（`runBatch` 读 `args.input`）
7. **base64 会灌爆 stdout**：`agnes-image` 的 `data.refUrls` 只能回摘要
8. **key 泄漏**：所有进 `message`/`details` 的 provider 文本必须过 `scrub`；每个新 e2e 都要有 `not.toContain(KEY)` 断言
9. **未登记的错误码会静默降级**成 `E_INTERNAL`（`src/core/errors.ts:57-69` 的 `asCodedError`）——只用现有 12 个
10. **`index.mjs` 300 行红线**：`media-image/index.mjs` 加两个命令必然超线，media-24 要顺手把 handler 挪进 `lib/commands.mjs`
11. **不要重构 modelscope-image 的既有行为**：media-22 抽 `runImageGen` 后，现有 4 个 e2e 文件必须一行不改全绿
12. **文档数字纪律**：没跑过的数字不许写。宁可写 `待实测`

## 11. 执行结果与实测修正（2026-10-14 回填，优先级高于本文档前 10 节）

> 本节是**真实执行 + 真实 API 探测**的结果。前文任何与本节冲突的表述，以本节为准。
> 最终状态：`pnpm lint` 干净、`pnpm build` 成功、`npx vitest run` → **503 passed / 1 skipped**（47 个文件）。
> 基线（执行前）为 247 passed / 1 skipped，本阶段净增 256 个用例。

### 11.1 对前文决策的推翻

| 原决策 | 实测结论 | 现在的实现 |
|---|---|---|
| **D22**「503 只退避不换 key，429 走轮换」 | **429 不是"换 key 就有用"的错误**：免费档 20s 内 3 次提交即触发 burst 限流，约 3.5 分钟自愈，与 key 无关；单 key 池下按 D22 实现会让 `AGNES_MAX_RETRIES` 对视频**完全失效**（实测 3 次提交 / 16.7s 就死） | **D22 作废**。429 与 503 同属"容量类"，一律**同 key 原地退避重试**，预算耗尽才轮换；退避阶梯改为 `[20,40,60,90,120,120]s`（累计 450s > 3.5min 恢复窗口），并优先服从 `Retry-After` 头/字段 |
| **§6.2 本地检测「不规则宫格天然有效」** | 真实分镜页（倾斜面板 + 黑描边压在白底上）会被描边横穿，严格判据必失效 | 已在 §6.2 改为背景占比 + 对齐性校验，**不规则页必须走视觉模型**；另修掉一个"满铺宫格（无外边距）检不出"的缺陷 |
| **§6.1/§6.2「统一 schema，中间零转换」** | 视觉模型放大回原图时会产生 ±1px 取整重叠，而消费端按绝对规则**拒收兄弟命令的产出**，管线端到端断裂 | 生产端新增窄条重叠修复（`data.overlapRepaired`），消费端改为分档：≤`--max-overlap`（默认 0.02）只警告 `E_CELLS_OVERLAP` 并照常渲染，超过才 `E_INVALID_OPTION`，`--allow-overlap` 全抑制 |
| **F1「请求体瘦身是稳定性关键」**（执行中写入） | **前提为假**：`--max-side 512`（体积 −89.5%）与默认值超时表现完全一致，延迟在 provider 侧 | 降采样保留但改用 **JPEG q82** 重编码（PNG 无损重编码只减 9.2%，JPEG 实测 7.94MB→**398KB**，约 20×）；真正的修复是把该命令超时默认提到 **300s**（`--timeout` 可覆盖，`DOUBAO_TIMEOUT_MS` 亦可） |
| **§1.3「Turbo 2048² 约 25–30s」** | 端到端实测 **37.1s** | 文档与命令描述已改为 37.1s |
| **§1.1「i2i 20–98s」** | 含内部重试的一次成功实测 **157.8s** | 文档改为 20–158s |
| **§8 V4「单张参考图体积上限待实测」** | 4096x4096 / 10.5MB PNG 内联成 **14MB data URI 被接受** | 已记入 README/SKILL |
| **§8 V6「scale 是否够盖」** | `--scale 1.2` 对**正脸够用**，但**侧脸的眼睛会露在圆外**（真实身份泄漏）；`--scale 1.6` 覆盖完整 | 默认仍 1.2，SKILL 明确建议含侧脸/转头时用 **1.5–1.6** |
| **§8 V2「2K/3K 档真实像素」** | `2K`+`1:1` = **2048x2048**，与"档位=面积"一致 | 已回填 |

### 11.2 agnes-video：提交侧已实测，生成侧仍受 provider 容量阻塞

两次独立窗口共 **64 次提交全部 HTTP 503 `video_queue_full`**（前一次 66 分钟 / 46 次，本次 21.8 分钟 / 18 次），而**同一把 key 在最后一次 503 之后 94 秒调用生图端点返回 200（11.1s）**——证明是**视频 lane 容量**，不是账号、不是请求格式、不是网关故障。

已实测（可写文档）：
- 三种 `mode` 的 body 全部通过校验并抵达队列闸口 → 字段名与形态正确；`seconds` 必须是 JSON 字符串（发数字会导致整体 `invalid_json`）。
- 校验**先于**队列检查（坏 `size` 秒回 400，合法 body 要等 3.5–7.6s 才拿到 503）。
- **错误信封与官方文档不符**：实际是 `{"code":"invalid_request","message":"…","data":{"param":…}}`，**没有 `detail` 键**；文案也不同（`size must be one of 720P`、`videos[0] must be an object`）。
- 队列满的信封是 `{"code":"video_queue_full","message":"…","data":null}`，与图片 lane 的 `{"error":{…}}` **结构不同**。
- 两条轮询路由都真实存在且**都需要 auth**，但错误信封不同：`GET /agnesapi?video_id=&model_name=` → 404 `{"error":{"code":404,"message":"task not found"}}`；`GET /v1/videos/{id}` → 400 `{"code":"task_not_exist",…}`。`GET /v1/tasks/{id}` **不存在**。
- burst 限流：3 次/20s → 429，约 3.5 分钟自愈，**提交间隔 ≥75s 可完全避开**。

**仍未实测、禁止写成事实**：提交成功响应体与 task id 字段、真实轮询哪条路由可用、`status` 取值集合、`internal_status` 是否滞后、4s/720P 端到端耗时、最终视频 URL、5 张 `images` 是否真被接受。**没有产出过任何 mp4。**

工程结论：`AGNES_MAX_RETRIES` / `AGNES_TIMEOUT_MS` 只约束**单次调用**；要熬过这种持续饱和的 lane，需要**调用方级的重提循环**（插件未提供）。已验证修复后的重试在真实环境行为正确：9 次提交全部钉在 `keyIndex:0`、精确服从 `AGNES_MAX_RETRIES=8`、`E_PROVIDER_RETRY` 进入 `warnings[]`、每次拒绝的 request id 都留在 `details.attempts`。

### 11.3 真实交付物（用户诉求）

- **分镜加字幕**：`S019.png` 与 `S017.png`（各 2048x2048、倾斜不规则宫格）已产出带字幕版本，逐条目检确认：中文字形真实渲染（非豆腐块）、黑条落在各自面板内、**未遮挡任何人脸**、文本与面板按"包含气泡中心点"配对（朴素 (y,x) 排序会把两条互换，已实测验证）。
- **遮脸**：`CR61.jpg` 检出 3 张脸、背面人物**无误检**、EXIF 旋转变体坐标准确；`--min-confidence 0.6` 正确剔除 0.589 的侧脸。
- **诚实结论**：视觉定位**不是** fire-and-forget——单页 181–330s、并发会超时、S017 曾把相邻两格合并（导致一条台词被丢）。**每次都必须目检返回的框**。当前可用配方：跑 `doubao-grid-locate` → 目检/必要时手改 cells.json → `media-grid-caption --allow-overlap`。

### 11.4 遗留（不阻塞本阶段）

- 面板是倾斜的，而字幕条是轴对齐矩形，因此会溢出倾斜边框几像素进入白色留白；`--padding`/`--position` 只能缓解，无 per-cell `yOffset`。
- 台词数 > 面板数时，重复 index 会硬失败（`cells-io.mjs`），需要人工合并——缺少"N 条贴到 M 格"的表达方式。
- 纯 `--json` 模式下 `logger.warn` 仍被 `src/core/output/logger.ts:22` 抑制，重试进度只能靠 `warnings[]` 与 `--json --verbose` 暴露（本阶段按约束未改 `src/`）。
- `tests/**/*.test.ts` 多个文件超过 300 行（AGENTS.md 该条在实践中对测试不严格执行，仓库既有文件已如此）。

### 11.5 管线不变量（2026-10-15 回填：修掉 §11.1 那条「分档 0.02」留下的洞）

§11.1 把消费侧改成「≤ `--max-overlap`（默认 0.02）只警告」时，没有和生产侧的修复窗口对齐：
`plugins/doubao/lib/grid-image.mjs` 的 `DEFAULT_OVERLAP_LIMIT` 是 **0.05**，于是**生产端有权发出的文件，
消费端默认设置照样拒收**——§2「产出即可消费、零转换」在数字层面仍然破着。实测两次真实调用都撞上：

- 旧 cells 文件（早于修复窗口的构建产出）：S019 两格重叠 628x24px = 占较小格 **3.70%** → `E_INVALID_OPTION`、不出图；
  S017 最坏一组 306x128px = **4.57%**（薄边 17.6%，窗口外所以生产侧不修）→ 同样整页拒收。
- 新真实调用（2026-10-15）：S017 产出 202x60px = **3.51%**（薄边 12.4%，生产侧按窗口不修）→ 0.02 下照样断链。

**现在的口径**：`DEFAULT_MAX_OVERLAP = 0.05`，与生产侧修复窗口**同一个数**。不变量成立的理由是几何恒等式：
设 S 为较小面积的格，`areaRatio = (box.w/S.w)·(box.h/S.h) ≤ min(box.w/S.w, box.h/S.h) = 生产侧的薄边判据`
（另一因子恒 ≤ 1），所以**凡落在生产侧修复窗口（薄边 ≤5%）里的重叠，面积占比必然也 ≤5%** → 只警告、照常渲染。
生产侧切齐是尽力而为（削掉较大格 >25% 面积的那一刀它主动放弃），这类残渣正是旧阈值会误杀的对象。
真误检（实测 22%–33% 面积、两格 30% 重合）离 5% 还有 4 倍以上余量，照旧硬拒 `E_INVALID_OPTION`。
钉这条不变量的用例：`tests/unit/grid-overlap.test.ts` 的「管线不变量」describe（含两侧常量同源断言、
窗口边界扫描、切齐失败的最坏残渣、30% 重合仍硬拒）与 `tests/e2e/media-grid-caption.e2e.test.ts` 的
「不变量：产出侧窗口内的实测残渣…」两条端到端用例（后者直接断言旧行为「exit 2 且不写文件」已消失）。
`--max-overlap` / `--allow-overlap` 仍是用户自己的出口，语义未变。

## 10. 执行顺序与 commit 边界

```
V0 探测（agnes-video）        → 回填 §1.2，不产生 commit
media-21  plugins/agnes/       → lint+build+test 全绿 + 真实链路各跑一次 → commit
media-22  modelscope-image-fast → 全绿 + 真实跑一次 2048² → commit
media-23  media-face-cover     → 全绿 + 真人脸手工验证 → commit
media-24  grid-locate+caption  → 全绿 + 真实宫格图手工验证 → commit
media-25  skill/README/zshrc   → spec 能看到 6 个新命令 + 两份 SKILL.md 一致 → commit
```
每个 commit message 格式：`media-NN: 摘要`（照 git log 现有风格，摘要里写清实测数字与坑）。
**不要 push、不要 npm publish**——等用户明确确认。
