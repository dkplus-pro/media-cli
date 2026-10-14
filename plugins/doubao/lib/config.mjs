import { cliError } from "./errors.mjs";

// Ark 的 OpenAI 兼容聊天端点在 /api/v3；/api/compatible 路径不存在（404）
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_TIMEOUT_MS = 120_000;
// 视觉（宫格定位）的单次请求预算：转写那套 120s 完全不适用。
// 实测同一张 2048x2048 真实分镜页（缩到长边 1568 送模型）：
//   S019 329.6s、S017 181.8s；`--max-side 512`（请求体再瘦 89.5%）没有变快，
//   仍是 3 次 × 120s 全部 abort（累计 362.7s）→ **耗时是 provider 侧的，与请求体大小无关**。
// 取 300s（= 已实测最慢 329.6s 的同一量级，且与 MODELSCOPE_TIMEOUT_MS 默认值一致）：
// 覆盖两次实测值需要 ≥330s，但两次的均值 255s 在 300s 内；一次 abort 后 chatWithRetry 还会
// 退避重试（400ms/1200ms），所以慢页靠第二次请求兜住。要一次性兜住 329.6s 就 --timeout 360000。
export const GRID_LOCATE_TIMEOUT_MS = 300_000;

// 模型 id 不内置默认值：豆包型号按月更新，写死会随时间失效
export const MODEL_VAR = "DOUBAO_TRANSCRIBE_MODEL";
// 视觉（宫格定位）模型同理：只从 env/--model 取，绝不写死型号（D29）
export const VISION_MODEL_VAR = "DOUBAO_VISION_MODEL";

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// env 读取必须在 handler 内（index.mjs 顶层零副作用），否则缺 key 会让整个 CLI 崩溃
// options.timeoutMs：**本命令的超时下限默认值**（不同命令差很远：转写 120s 够用，视觉宫格定位要 300s）。
// 与 analysis.mjs 的 Math.max 下限不同：这里 DOUBAO_TIMEOUT_MS 是**真覆盖**（可以往大也可以往小），
// 因为慢页的实测方差是 provider 侧的，用户有时要 360s、e2e 有时要 2s。
export function getConfig(env = process.env, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = env.DOUBAO_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw cliError("E_CONFIG", "缺少 DOUBAO_API_KEY（火山方舟控制台创建）", {
      var: "DOUBAO_API_KEY",
    });
  }
  return {
    apiKey: apiKey.trim(),
    baseUrl: (env.DOUBAO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    // null 表示未配置：由 --model 兜底，两者都缺时 transcribe 报 E_CONFIG
    model: (env.DOUBAO_TRANSCRIBE_MODEL ?? "").trim() || null,
    // 同上：null 表示未配置，由 --model 兜底，两者都缺时 grid-locate 报 E_CONFIG
    visionModel: (env[VISION_MODEL_VAR] ?? "").trim() || null,
    timeoutMs: positiveInt(env.DOUBAO_TIMEOUT_MS, timeoutMs),
  };
}
