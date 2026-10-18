import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { clipText, DEFAULT_TIMEOUT_MS, scrubKey } from "./client.mjs";
import { cliError } from "./errors.mjs";

const HEX_RE = /^[0-9a-fA-F]+$/;
const URL_RE = /^https?:\/\//i;

function budgetOf(timeoutMs) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_TIMEOUT_MS;
}

// data.* 优先；个别网关把字段铺在顶层时也认
function fieldOf(payload, name) {
  for (const container of [payload?.data, payload]) {
    const value = container?.[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

// 直链是对象存储签名 URL：不带 Authorization，避免把 key 发给第三方
async function downloadAudio(config, url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(budgetOf(timeoutMs)) });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const message = clipText(scrubKey(err?.message ?? err, config?.apiKey));
    throw cliError(
      "E_PROVIDER_ERROR",
      timedOut ? "MiniMax 音频下载超时" : `MiniMax 音频下载失败：${message}`,
      {
        source: "minimax",
        reason: timedOut ? "timeout" : "network",
        url,
      },
    );
  }
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `MiniMax 音频下载失败（HTTP ${res.status}）`, {
      source: "minimax",
      status: res.status,
      url,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "MiniMax 音频下载结果为空", {
      source: "minimax",
      reason: "empty_audio",
      url,
    });
  }
  return buf;
}

// data.audio 常态是 hex（不是 base64）；也兼容 data.audio / data.audio_url 直接给 URL
export async function decodeAudio(config, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const audioUrl = fieldOf(payload, "audio_url");
  const audio = fieldOf(payload, "audio");
  if (audioUrl !== "") return downloadAudio(config, audioUrl, timeoutMs);
  if (audio !== "" && URL_RE.test(audio)) return downloadAudio(config, audio, timeoutMs);
  if (audio === "") {
    throw cliError("E_PROVIDER_ERROR", "MiniMax 响应缺少 data.audio 音频数据", {
      source: "minimax",
      reason: "empty_audio",
    });
  }
  const hex = audio.replace(/\s+/g, "");
  if (!HEX_RE.test(hex) || hex.length % 2 !== 0) {
    throw cliError("E_PROVIDER_ERROR", "MiniMax 的 data.audio 不是合法 hex 音频", {
      source: "minimax",
      reason: "invalid_audio",
      sample: hex.slice(0, 40),
    });
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length === 0) {
    throw cliError("E_PROVIDER_ERROR", "MiniMax 音频解码结果为空", {
      source: "minimax",
      reason: "empty_audio",
    });
  }
  return buf;
}

// 输出路径按 ctx.cwd 解析，父目录必须已存在；本地问题不发网络、不写盘
export async function outputPathOf(ctx, outputArg, defaultName) {
  const target =
    typeof outputArg === "string" && outputArg.trim() !== "" ? outputArg.trim() : defaultName;
  const output = path.resolve(ctx.cwd, target);
  const parent = await stat(path.dirname(output)).catch(() => null);
  if (!parent?.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输出目录不存在：${path.dirname(output)}`, {
      option: "--output",
      value: output,
    });
  }
  return output;
}

export async function writeOutput(ctx, outputArg, defaultName, buf) {
  const output = await outputPathOf(ctx, outputArg, defaultName);
  await writeFile(output, buf);
  ctx.logger.info(`已写入 ${output}`);
  return output;
}
