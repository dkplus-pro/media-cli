# 阶段 04 — suno-music 插件（文生音乐 / 文生音效）

> 前置依赖：阶段 01（E_CONFIG / E_PROVIDER_ERROR 已登记）。目标：open.suno.cn 中转 API 的文生音乐与文生音效，默认等待完成并下载（D3/D11）。

## 范围

做：`suno-gen` / `suno-sound` / `suno-task` / `suno-download` / `suno-balance` 五命令；提交→轮询→下载链路；e2e（本地 mock 服务器模拟任务生命周期）。
不做：延长/翻唱/上传参考音频/MV 生成等扩展端点（API 支持，本期不做，留待演进）；音频转存格式转换；任何新增 npm 依赖。

## 插件结构

```
plugins/suno-music/
  index.mjs        # manifest：5 命令声明
  lib/client.mjs   # Bearer 认证 + /api/v1 路由 + 错误映射
  lib/poll.mjs     # 轮询循环（间隔/超时可配）
  lib/download.mjs # 限时 URL 下载落盘
```

## 任务清单

### T1 `lib/client.mjs` — API 客户端

- 认证：所有请求带 `Authorization: Bearer <SUNO_API_KEY>`；env 缺失 → `E_CONFIG`（details 提示在 open.suno.cn 商户后台创建 key）。
- `SUNO_BASE_URL` 默认 `https://open.suno.cn`（D11，e2e 指向 mock）。
- 端点封装（已核实，见 master-plan §3.4）：
  - `generateMusic(body)` → `POST /api/v1/music/generate`，响应 `{ data: { task_ids: number[] } }`
  - `generateSound(body)` → `POST /api/v1/music/sound`
  - `getTask(id)` → `GET /api/v1/music/task?id=`，状态 `pending/processing/completed/failed`
  - `getBalance()` → `GET /api/v1/points/balance` → `data.remaining_points`
- 错误映射：401/403 → `E_CONFIG`（key 无效）；402 → `E_PROVIDER_ERROR`（`details.reason: "insufficient_points"`）；其余非 2xx → `E_PROVIDER_ERROR`（透传状态码与响应摘要）；网络异常 → `E_PROVIDER_ERROR`。
- 结果映射：`result.fileInfo.mp3Url`（音频，**限时 1 小时**）、`result.fileInfo.duration`、`result.fileInfo.cosUrl`（封面）、`result.custom_id`（UUID，后续操作用，与数字 task_id 区分）。

### T2 `lib/poll.mjs` + `lib/download.mjs` — 轮询与下载（D3）

- 轮询：间隔 `SUNO_POLL_INTERVAL_MS`（默认 5000），总超时 `SUNO_TIMEOUT_MS`（默认 600000）；多 task 并行轮询（每 5s 批量查各自状态即可，逐个 `getTask` 亦可）。
- 终态：`completed` → 立即下载 `mp3Url`（限时）；`failed` → 记入 `failed[]`（API 侧自动退积分）。
- 超时：throw `E_PROVIDER_ERROR`，`details: { reason: "timeout", taskIds }` —— taskIds 保留，调用方可拿 `suno-download` 恢复，不浪费已扣积分。
- 下载：流式写盘（`fs.writeFile(Buffer.from(await res.arrayBuffer()))` 即可，单文件几 MB）；下载失败 → `E_PROVIDER_ERROR`。

### T3 `suno-gen` — 文生音乐

- 校验：`--prompt` 与 `--lyrics` **二选一必填**（都缺 → `E_MISSING_ARGUMENT`；都给 → `E_INVALID_OPTION`）。
- 请求体映射：`--prompt` → 灵感模式 `gpt_description_prompt`；`--lyrics` → 自定义模式 `prompt` + `--tags` → `tags`；`--instrumental` → `make_instrumental: true`；`--title` → `title`；`--model` → `mv`（默认 `chirp-hawk`，可选 `chirp-hawk-wild` / `chirp-goose`，白名单校验）。
- API 每次生成 2 首（返回 2 个 task_ids）。
- 等待模式（默认）：轮询全部 task → data：`{ tracks: [{ taskId, customId?, title?, durationSec?, path?, bytes? }], failed: [{ taskId, reason }] }`；有任一首落盘 → exit 0；全部 failed → `E_PROVIDER_ERROR`。
- `--no-wait`：提交即返回 data `{ taskIds: [...] }`（轮询参数忽略）。
- `--output`：单文件下载目标；2 首时按 `<output 去扩展名>-1/-2.mp3` 命名；缺省 `./suno-<taskId>.mp3`。

### T4 `suno-sound` — 文生音效

- `--text` 必填（→ `title`）；`--tags` 风格；`--loop` → `loop: true`；`--model` 白名单 `chirp-crow | chirp-fenix`（sound 专有限定）。
- 走 `POST /api/v1/music/sound`（后端固定 `task=sound` / `generation_type=TEXT` / `make_instrumental=true`，插件不传这三个字段）。
- 轮询/下载/`--no-wait` 语义与 `suno-gen` 完全一致（复用 poll/download）。

### T5 `suno-task` / `suno-download` / `suno-balance` — 辅助命令

- `suno-task --id <taskId>`（必填）→ data：`{ taskId, status, title?, durationSec?, audioUrl?, coverUrl?, customId? }`（仅 completed 映射文件字段）。
- `suno-download --id <taskId> --output <path>`（均必填）：查 task → 非 completed → `E_PROVIDER_ERROR`（details 带当前 status）；completed → 下载 mp3Url 落盘，data `{ path, bytes, durationSec }`。
- `suno-balance` → data `{ remainingPoints }`。

### T6 e2e `tests/e2e/suno-music.e2e.test.ts`（mock 服务器，D11）

- `node:http` mock：`/api/v1/music/generate` 返回固定 task_ids；`/api/v1/music/task?id=` 按**请求次数**依次返回 pending → processing → completed（携带 mp3Url 指向 mock 自身的 `/file.mp3`）；`/api/v1/music/sound`、`/api/v1/points/balance` 同理。
- `SUNO_POLL_INTERVAL_MS=10`、`SUNO_TIMEOUT_MS=500`（测试加速）。
- 覆盖用例：
  1. `suno-gen --prompt x` 等待模式：下载落盘、`data.tracks[0].path` 存在、customId 映射正确。
  2. `--no-wait`：立即返回 `{ taskIds: [204, 205] }`，不产生 task 查询。
  3. `suno-sound --text x`：请求体走 `/music/sound` 且含 title/tags。
  4. `suno-task --id 204`：status/字段映射正确。
  5. `suno-download --id 204 --output x.mp3`：文件落盘；mock 返回 pending 时 → `E_PROVIDER_ERROR`。
  6. `suno-balance`：`remainingPoints` 正确。
  7. 401 → `E_CONFIG`、exit 3；402 → `E_PROVIDER_ERROR` 且 `details.reason === "insufficient_points"`。
  8. 超时：mock 永远返回 pending + `SUNO_TIMEOUT_MS=50` → `E_PROVIDER_ERROR`、`details.taskIds` 保留。
  9. 缺 `SUNO_API_KEY` → `E_CONFIG`（不发请求）；缺 `--id` → `E_MISSING_ARGUMENT`、exit 2。

### T7 文档同步

- `README.md`：新增 suno-music 小节（env 表 + gen/sound/sound/download/balance 示例 + 限时下载说明）。

## 执行方式（planner 编排 + 主 agent 执行）

planner 按 T1→T7 派发（T1→T2 是地基，T3/T4/T5 复用 poll/download，T6 在接口定型后写）；主 agent 串行执行。禁止事项：任何日志/错误信息不得包含 SUNO_API_KEY；不引入 npm 依赖；轮询不做交互式进度条（stderr 日志即可）。完成跑验收块，commit `media-04: suno-music plugin with generate, sound, task helpers`。

## 验收标准（主 agent 执行并回报证据）

```bash
pnpm lint && pnpm build && pnpm test                  # 全绿（全部走本地 mock，不依赖真实 key）
SUNO_API_KEY=real-key node dist/common-cli.js --json suno-gen --prompt "lo-fi hip hop" --output /tmp/s.mp3
#   真实 key 就绪时：退出 0；/tmp/s.mp3 存在；data.tracks 长度 ≤ 2 且含 durationSec
SUNO_API_KEY=real-key node dist/common-cli.js --json suno-sound --text "thunder rain" --loop --output /tmp/t.mp3
#   退出 0；/tmp/t.mp3 存在
node dist/common-cli.js --json suno-gen --prompt x --no-wait   # mock/真实均可：data.taskIds 为数组
node dist/common-cli.js --json suno-gen               # exit 2；E_MISSING_ARGUMENT（prompt/lyrics 均缺）
SUNO_API_KEY=real-key node dist/common-cli.js --json suno-balance   # data.remainingPoints 为数字
node dist/common-cli.js --json spec | grep suno-      # spec 含五个 suno-* 命令，source 为 plugin:suno-music
```
