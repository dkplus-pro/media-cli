import { cliError } from "./errors.mjs";

// 官方默认带 /v1；归一后一律裁掉，调用方自己拼 /v1/... 与 /v2/...
export const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
export const DEFAULT_SPEECH_MODEL = "speech-2.8-hd";
export const DEFAULT_MUSIC_MODEL = "music-3.0";
export const DEFAULT_VIDEO_MODEL = "MiniMax-H3";
export const DEFAULT_VIDEO_REGEN_MODEL = "MiniMax-H3";
export const DEFAULT_IMAGE_MODEL = "MiniMax-H3-Image";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

// 容忍末尾斜杠与误填的 /v1：`https://x/v1/` → `https://x`
// 非法 URL / 非 http(s) 协议直接 E_CONFIG，且指明是哪个环境变量
export function normalizeBase(raw, name = "MINIMAX_API_BASE_URL") {
  const value = trimmed(raw);
  const target = value === "" ? DEFAULT_BASE_URL : value;
  let url;
  try {
    url = new URL(target);
  } catch {
    throw cliError("E_CONFIG", `${name} 不是合法 URL：${target}`, { var: name, value: target });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliError("E_CONFIG", `${name} 协议必须是 http/https`, { var: name, value: target });
  }
  return target.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// 主名 MINIMAX_API_BASE_URL 优先；兼容用户原文的笔误 MINIMAX_API_BASR_URL
function baseFromEnv(env) {
  const primary = trimmed(env.MINIMAX_API_BASE_URL);
  if (primary !== "") return { raw: primary, name: "MINIMAX_API_BASE_URL" };
  const alias = trimmed(env.MINIMAX_API_BASR_URL);
  if (alias !== "") return { raw: alias, name: "MINIMAX_API_BASR_URL" };
  return { raw: "", name: "MINIMAX_API_BASE_URL" };
}

// env 读取只发生在 handler 内（默认参数），index.mjs 顶层零副作用
export function loadConfig(env = process.env) {
  const apiKey = trimmed(env.MINIMAX_API_KEY);
  if (apiKey === "") {
    throw cliError("E_CONFIG", "缺少 MINIMAX_API_KEY", { var: "MINIMAX_API_KEY" });
  }
  const base = baseFromEnv(env);
  return {
    apiKey,
    baseUrl: normalizeBase(base.raw, base.name),
    speechModel: trimmed(env.MINIMAX_SPEECH_MODEL) || DEFAULT_SPEECH_MODEL,
    musicModel: trimmed(env.MINIMAX_MUSIC_MODEL) || DEFAULT_MUSIC_MODEL,
    videoModel: trimmed(env.MINIMAX_VIDEO_MODEL) || DEFAULT_VIDEO_MODEL,
    videoRegenModel: trimmed(env.MINIMAX_VIDEO_REGEN_MODEL) || DEFAULT_VIDEO_REGEN_MODEL,
    imageModel: trimmed(env.MINIMAX_IMAGE_MODEL) || DEFAULT_IMAGE_MODEL,
  };
}

function formatRange(min, max, minExclusive) {
  if (min === undefined && max === undefined) return "";
  if (min === undefined) return `≤ ${max}`;
  if (max === undefined) return `≥ ${min}`;
  return minExclusive ? `(${min}, ${max}]` : `${min}–${max}`;
}

// 命令参数的数值校验（未传回落 fallback）：范围/整数/开闭区间统一口径
export function parseNumberOption(value, option, options = {}) {
  const { min, max, minExclusive = false, integer = false, fallback } = options;
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  const aboveMin = min === undefined || (minExclusive ? num > min : num >= min);
  const belowMax = max === undefined || num <= max;
  if (!Number.isFinite(num) || (integer && !Number.isInteger(num)) || !aboveMin || !belowMax) {
    const kind = integer ? "整数" : "数";
    const range = formatRange(min, max, minExclusive);
    const suffix = range === "" ? "" : `（${range}）`;
    throw cliError("E_INVALID_OPTION", `${option} 必须是${kind}${suffix}，得到：${String(value)}`, {
      option,
      value,
    });
  }
  return num;
}
