import { cliError } from "./errors.mjs";

// 实测（§1.1/§1.2）：模型 id 是稳定产品名，所以有内置默认值；
// 与 modelscope 的「模型名必填」不同，与 D29（豆包按月换型号不写死）也不冲突
export const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com";
export const DEFAULT_IMAGE_MODEL = "agnes-image-2.5-flash";
export const DEFAULT_VIDEO_MODEL = "agnes-video-2.5-flash";
export const DEFAULT_TIMEOUT_MS = 360000;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_MAX_RETRIES = 6;

// D24：官方文档给的 base 带 /v1，与仓库约定（客户端自己拼 /v1/...）冲突。
// 尾部 / 与尾部 /v1 都裁掉，用户怎么写都能用
function requireUrl(raw, name) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    throw cliError("E_CONFIG", `缺少环境变量 ${name}`, { var: name });
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw cliError("E_CONFIG", `${name} 不是合法 URL`, { var: name, value });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliError("E_CONFIG", `${name} 协议必须是 http/https`, { var: name });
  }
  return value.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function optionalUrl(raw, name, fallback) {
  if (raw === undefined || raw.trim() === "") return fallback;
  return requireUrl(raw, name);
}

function positiveInt(value, name, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  const num = Number.parseInt(value, 10);
  if (!Number.isInteger(num) || num <= 0) {
    throw cliError("E_CONFIG", `${name} 必须是正整数毫秒`, { var: name, value });
  }
  return num;
}

// 队列满重试次数允许 0（关掉退避）；负数/非数字视为配置错
function nonNegativeInt(value, name, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  const num = Number.parseInt(value, 10);
  if (!Number.isInteger(num) || num < 0) {
    throw cliError("E_CONFIG", `${name} 必须是非负整数`, { var: name, value });
  }
  return num;
}

// D23：AGNES_KEY_POOL 逗号分隔多把，设置后覆盖单 key；未设置（或为空）退回 AGNES_API_KEY
export function parseKeys(env) {
  const pool = (env.AGNES_KEY_POOL ?? "").trim();
  const raw = pool === "" ? (env.AGNES_API_KEY ?? "") : pool;
  const keys = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    throw cliError("E_CONFIG", "缺少环境变量 AGNES_API_KEY（或 AGNES_KEY_POOL）", {
      var: "AGNES_API_KEY",
    });
  }
  return keys;
}

// env 读取只发生在 handler 内（loadConfig 的默认参数），index.mjs 顶层零副作用
export function loadConfig(env = process.env) {
  return {
    baseUrl: optionalUrl(env.AGNES_BASE_URL, "AGNES_BASE_URL", DEFAULT_BASE_URL),
    keys: parseKeys(env),
    imageModel: (env.AGNES_IMAGE_MODEL ?? "").trim() || DEFAULT_IMAGE_MODEL,
    videoModel: (env.AGNES_VIDEO_MODEL ?? "").trim() || DEFAULT_VIDEO_MODEL,
    timeoutMs: positiveInt(env.AGNES_TIMEOUT_MS, "AGNES_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollIntervalMs: positiveInt(
      env.AGNES_POLL_INTERVAL_MS,
      "AGNES_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
    ),
    maxRetries: nonNegativeInt(env.AGNES_MAX_RETRIES, "AGNES_MAX_RETRIES", DEFAULT_MAX_RETRIES),
  };
}
