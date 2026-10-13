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

// baseurl / apikey / modelname 由 ~/.zshrc 提供；model 也可每次传 --model
export function loadConfig(env = process.env) {
  return {
    baseUrl: requireUrl(
      env.MODELSCOPE_BASE_URL ?? "https://api-inference.modelscope.cn",
      "MODELSCOPE_BASE_URL",
    ),
    key: env.MODELSCOPE_API_KEY ?? "",
    model: env.MODELSCOPE_IMAGE_MODEL ?? "",
    timeoutMs: positiveInt(env.MODELSCOPE_TIMEOUT_MS, "MODELSCOPE_TIMEOUT_MS", 300000),
    pollIntervalMs: positiveInt(
      env.MODELSCOPE_POLL_INTERVAL_MS,
      "MODELSCOPE_POLL_INTERVAL_MS",
      2000,
    ),
  };
}
