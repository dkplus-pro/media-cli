import { cliError } from "./errors.mjs";

function requireUrl(raw, name) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw cliError("E_CONFIG", `缺少环境变量 ${name}`, { var: name });
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw cliError("E_CONFIG", `${name} 不是合法 URL`, { var: name, value: raw });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliError("E_CONFIG", `${name} 协议必须是 http/https`, { var: name });
  }
  // 容忍末尾斜杠与误填的 /v1（客户端统一拼 /v1/...）
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function positiveInt(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const num = Number.parseInt(value, 10);
  if (!Number.isInteger(num) || num <= 0) {
    throw cliError("E_CONFIG", `${name} 必须是正整数毫秒`, { var: name, value });
  }
  return num;
}

// 网关的并发与额度是按 key 计的（实测有任务在跑时同 key 直接 429），
// 所以多账号要开池：MODELSCOPE_KEY_POOL 逗号分隔；未设置时退回单个 MODELSCOPE_API_KEY
function parseKeys(env) {
  const raw = env.MODELSCOPE_KEY_POOL ?? env.MODELSCOPE_API_KEY ?? "";
  const keys = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    throw cliError("E_CONFIG", "缺少环境变量 MODELSCOPE_API_KEY（或 MODELSCOPE_KEY_POOL）", {
      var: "MODELSCOPE_API_KEY",
    });
  }
  return keys;
}

// baseurl / apikey（或多 key 池）/ modelname 由 ~/.zshrc 提供；model 也可每次传 --model
export function loadConfig(env = process.env) {
  return {
    baseUrl: requireUrl(
      env.MODELSCOPE_BASE_URL ?? "https://api-inference.modelscope.cn",
      "MODELSCOPE_BASE_URL",
    ),
    keys: parseKeys(env),
    model: env.MODELSCOPE_IMAGE_MODEL ?? "",
    timeoutMs: positiveInt(env.MODELSCOPE_TIMEOUT_MS, "MODELSCOPE_TIMEOUT_MS", 300000),
    pollIntervalMs: positiveInt(
      env.MODELSCOPE_POLL_INTERVAL_MS,
      "MODELSCOPE_POLL_INTERVAL_MS",
      2000,
    ),
  };
}
