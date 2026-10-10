import { cliError } from "./errors.mjs";

// Ark 的 OpenAI 兼容聊天端点在 /api/v3；/api/compatible 路径不存在（404）
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-2-0-mini-260428";
const DEFAULT_TIMEOUT_MS = 120_000;

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// env 读取必须在 handler 内（index.mjs 顶层零副作用），否则缺 key 会让整个 CLI 崩溃
export function getConfig(env = process.env) {
  const apiKey = env.DOUBAO_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw cliError("E_CONFIG", "缺少 DOUBAO_API_KEY（火山方舟控制台创建）", {
      var: "DOUBAO_API_KEY",
    });
  }
  return {
    apiKey: apiKey.trim(),
    baseUrl: (env.DOUBAO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.DOUBAO_TRANSCRIBE_MODEL || DEFAULT_MODEL,
    timeoutMs: positiveInt(env.DOUBAO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}
