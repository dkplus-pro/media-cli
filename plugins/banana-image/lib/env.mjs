import { cliError } from "./errors.mjs";

const QUALITIES = ["auto", "low", "medium", "high"];
// 实测 2026-10-19：generations 传非法值回 "moderation must be one of: auto, low"，枚举与 Azure 一致
const MODERATIONS = ["auto", "low"];
const OUTPUT_FORMATS = ["png", "jpeg", "webp"];
const DEFAULT_BASE = "https://api.bananarouter.com";

// 容忍末尾斜杠与误填的 /v1（客户端统一拼 /v1/...）
export function normalizeBase(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_BASE;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw cliError("E_CONFIG", "BANANA_IMAGE_API_BASE 不是合法 URL", {
      var: "BANANA_IMAGE_API_BASE",
      value: raw,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliError("E_CONFIG", "BANANA_IMAGE_API_BASE 协议必须是 http/https", {
      var: "BANANA_IMAGE_API_BASE",
    });
  }
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function positiveInt(raw, name, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw cliError("E_CONFIG", `${name} 必须是正整数毫秒`, { var: name, value: raw });
  }
  return n;
}

export function loadConfig(env = process.env) {
  const apiKey = env.BANANA_IMAGE_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw cliError("E_CONFIG", "缺少 BANANA_IMAGE_API_KEY", { var: "BANANA_IMAGE_API_KEY" });
  }
  const quality = env.BANANA_IMAGE_QUALITY ?? "low";
  if (!QUALITIES.includes(quality)) {
    throw cliError("E_CONFIG", `BANANA_IMAGE_QUALITY 仅支持 ${QUALITIES.join("|")}`, {
      var: "BANANA_IMAGE_QUALITY",
      value: quality,
    });
  }
  const outputFormat = env.BANANA_IMAGE_OUTPUT_FORMAT ?? "jpeg";
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    throw cliError("E_CONFIG", `BANANA_IMAGE_OUTPUT_FORMAT 仅支持 ${OUTPUT_FORMATS.join("|")}`, {
      var: "BANANA_IMAGE_OUTPUT_FORMAT",
      value: outputFormat,
    });
  }
  const moderation = env.BANANA_IMAGE_MODERATION ?? "low";
  if (!MODERATIONS.includes(moderation)) {
    throw cliError("E_CONFIG", `BANANA_IMAGE_MODERATION 仅支持 ${MODERATIONS.join("|")}`, {
      var: "BANANA_IMAGE_MODERATION",
      value: moderation,
    });
  }
  return {
    apiKey: apiKey.trim(),
    baseUrl: normalizeBase(env.BANANA_IMAGE_API_BASE),
    model: (env.BANANA_IMAGE_MODEL ?? "").trim() || "gpt-image-2",
    quality,
    moderation,
    outputFormat,
    timeoutMs: positiveInt(env.BANANA_IMAGE_TIMEOUT_MS, "BANANA_IMAGE_TIMEOUT_MS", 300_000),
  };
}

export { MODERATIONS, OUTPUT_FORMATS, QUALITIES };
