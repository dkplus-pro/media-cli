# 阶段 03 — azure-image 插件（Azure OpenAI gpt-image-2 生图）

> 前置依赖：阶段 01（E_CONFIG / E_PROVIDER_ERROR 已登记）。目标：Azure OpenAI `gpt-image-2` 生图——纯文案生图与参考图+文案生图（D4 池调度）。

## 范围

做：`image-gen` 单命令（有 `--ref` 走 images/edits、无则 images/generations）；key/endpoint 池解析、随机调度与失败轮换；e2e（本地 mock 服务器）。
不做：多账号并发/配额统计；DALL-E 3 等其它模型适配；图片后处理；任何新增 npm 依赖（Node 20 原生 `fetch` / `FormData` / `Blob`）。

## 插件结构

```
plugins/azure-image/
  index.mjs        # manifest：image-gen 声明
  lib/env.mjs      # 池解析与校验
  lib/client.mjs   # fetch 封装：随机起点 + 轮换重试
```

## 任务清单

### T1 `lib/env.mjs` — 池解析与校验（D4）

- 读 `AZURE_IMAGE_KEY_POOL` / `AZURE_IMAGE_ENDPOINT_POOL`：英文逗号分隔、trim 空项。
- 缺任一 env 或解析后为空 → `E_CONFIG`（details 指明缺哪个变量）。
- 两池**长度必须相等** → 不等 → `E_CONFIG`，`details: { keyCount, endpointCount }`。
- 每个 endpoint 校验为合法 http(s) URL（否则 `E_CONFIG`）。
- 其余 env：`AZURE_IMAGE_DEPLOYMENT`（默认 `gpt-image-2`）、`AZURE_IMAGE_OUTPUT_FORMAT`（默认 `png`，白名单 png/jpeg/webp）、`AZURE_IMAGE_QUALITY`（默认 `auto`）、`AZURE_IMAGE_API_VERSION`（默认 `2025-04-01-preview`；若 Azure 要求 gpt-image-2 使用更新版本，用户设此 env 即可，无需改代码）。

### T2 `lib/client.mjs` — 池调度与请求（D4）

- 账号 = `{ endpoint, key }` 按**索引配对**。
- 每次调用**随机选起点**，循环池发起请求；重试条件：HTTP 401/403/429/5xx 或网络异常（fetch reject）→ 轮换下一账号；每账号至多尝试 1 次，总尝试 ≤ 池大小；400 类参数错误不轮换（换账号无意义）直接失败。
- 全部尝试失败 → `E_PROVIDER_ERROR`，`details: { attempts: [{ index, status?, message 摘要 }] }`（**绝不**包含 key）。
- 请求端点：
  - generations：`POST {endpoint}/openai/deployments/{deployment}/images/generations?api-version={v}`，body `{ prompt, size, quality, output_format, n: 1 }`
  - edits：同路径 `/images/edits`，`multipart/form-data`（`image[]` 逐个以 `Blob` 附文件，`prompt`/`size`/`quality` 文本字段）；参考图文件不存在 → `E_MISSING_ARGUMENT`
- 响应解析：`data[0].b64_json`（gpt-image 系列固定返回 b64；若为空 → `E_PROVIDER_ERROR`）。

### T3 `image-gen` 命令（manifest 声明）

- `--prompt` 缺失 → `E_MISSING_ARGUMENT`；`--size` 校验 `^\d{3,4}x\d{3,4}$` → 否则 `E_INVALID_OPTION`。
- 输出：b64 → Buffer 写 `--output`（默认 `./generated-<ISO 时间戳>.png`，扩展名跟随 `AZURE_IMAGE_OUTPUT_FORMAT`）。
- data（契约见 master-plan §3.2）：`{ path, bytes, format, size, revisedPrompt?, account: { index, endpoint } }`。
- human 模式输出文件路径。

### T4 e2e `tests/e2e/azure-image.e2e.test.ts`（mock 服务器，D11）

- `node:http` 起本地 mock（127.0.0.1 随机端口），`AZURE_IMAGE_ENDPOINT_POOL` 指向它（多账号用不同 path 前缀或多端口区分）。
- 覆盖用例：
  1. generations 成功：返回 `b64_json` → 文件落盘、`data.account.index` 正确、请求体含 prompt/size/quality/output_format。
  2. edits 成功：断言 mock 收到 multipart 且 `image[]` 文件内容与 fixture 一致。
  3. 轮换成功：账号 0 返回 429、账号 1 返回 200 → `data.account.index === 1`，总请求 2 次。
  4. 全池失败：两账号均 429 → `E_PROVIDER_ERROR`、exit 3、`details.attempts` 长度 2、不含 key。
  5. 参数错误不轮换：账号 0 返回 400 → 立即 `E_PROVIDER_ERROR`、总请求 1 次。
  6. 配置分支：两池长度不等 → `E_CONFIG`（不发任何请求）；缺 env → `E_CONFIG`。
  7. 随机起点分布：连续 N 次单账号成功场景下不 crash 即可（随机性不断言具体值）。

### T5 文档同步

- `README.md`：新增 azure-image 小节（env 配置表 + 纯文案/参考图两示例 + api-version 说明）。

## 执行方式（planner 编排 + 主 agent 执行）

planner 按 T1→T5 派发（T1→T2→T3 强耦合串行，T4 mock 用例在 T2 接口定型后写）；主 agent 串行执行。禁止事项：任何日志/错误信息不得包含 key；不重试 400；不动 `AGENTS.md`。完成跑验收块，commit `media-03: azure-image plugin with pool scheduling`。

## 验收标准（主 agent 执行并回报证据）

```bash
pnpm lint && pnpm build && pnpm test                  # 全绿（真实 API 用例不在 e2e 中）
AZURE_IMAGE_KEY_POOL=k1,k2 \
AZURE_IMAGE_ENDPOINT_POOL=https://e1,https://e2 \
node dist/common-cli.js --json image-gen --prompt "a red apple" --output /tmp/apple.png
#   真实 key 就绪时：退出 0；/tmp/apple.png 存在且为 PNG；data.account.index ∈ {0,1}
AZURE_IMAGE_KEY_POOL=k1 AZURE_IMAGE_ENDPOINT_POOL=https://e1,https://e2 \
node dist/common-cli.js --json image-gen --prompt x
#   exit 3；error.code === "E_CONFIG"（池长度不等）
node dist/common-cli.js --json image-gen              # exit 2；E_MISSING_ARGUMENT
node dist/common-cli.js --json spec | grep image-gen  # source 为 plugin:azure-image
```
