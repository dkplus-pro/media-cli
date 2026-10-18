import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getConfig } from "./config.mjs";
import { cliError } from "./errors.mjs";

// 火山方舟生图（media-08 / D42）：POST /images/generations → TOS 签名 URL → 不带 Authorization 下载落盘。
// 与转写/视觉不同，这里不复用 lib/ark.mjs 的 chatWithRetry：端点与响应形态都不同，
// 且生图没有「空内容」概念。错误码只复用已登记的 E_CONFIG / E_PROVIDER_ERROR /
// E_MISSING_ARGUMENT / E_INVALID_OPTION（D43），细节放 details。

const DEFAULT_MODEL = "doubao-seedream-4-5-251128";
const MODEL_VAR = "DOUBAO_IMAGE_MODEL";
const DEFAULT_SIZE = "2048x2048";
const DEFAULT_TIMEOUT_MS = 180_000;
// 实测下限 3,686,400 px：1024x1024（1,048,576 px）会被 provider 拒，必须本地先拦（省一次额度）
const MIN_PIXELS = 3_686_400;
const SIZE_RE = /^(\d{3,5})x(\d{3,5})$/;
const SOURCE = "doubao-image";

function requirePrompt(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  return value.trim();
}

// 只收 WxH（provider 实测格式）；总像素低于下限本地即拒，绝不发网络
export function parseImageSize(value = DEFAULT_SIZE) {
  const raw = String(value).trim();
  const match = SIZE_RE.exec(raw);
  if (match === null) {
    throw cliError("E_INVALID_OPTION", `--size 必须是 WxH 格式（如 ${DEFAULT_SIZE}）：${raw}`, {
      option: "--size",
      value: raw,
    });
  }
  const pixels = Number(match[1]) * Number(match[2]);
  if (pixels < MIN_PIXELS) {
    throw cliError(
      "E_INVALID_OPTION",
      `--size 总像素不得少于 ${MIN_PIXELS}（provider 实测下限，${raw} 只有 ${pixels} px，1024x1024 会被拒）`,
      { option: "--size", value: raw, pixels, minPixels: MIN_PIXELS },
    );
  }
  return raw;
}

// --timeout 只收正整数毫秒；故意不读 DOUBAO_TIMEOUT_MS（那是转写/视觉的预算，单位同为 ms 但语义不同）
function parseTimeoutMs(raw) {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw cliError("E_INVALID_OPTION", `--timeout 必须是正整数毫秒，得到：${raw}`, {
      option: "--timeout",
      value: String(raw),
    });
  }
  return n;
}

// 请求体字段全部为实测被接受的最小集：url 取件、默认不加水印、关掉组图（一次一张）
export function buildImageBody({ model, prompt, size, watermark }) {
  return {
    model,
    prompt,
    size,
    response_format: "url",
    watermark: watermark === true,
    sequential_image_generation: "disabled",
  };
}

// key/base 与转写同源（getConfig 不强制转写模型，缺 key 时干净地 E_CONFIG）；
// 图像模型只认 --model 或 DOUBAO_IMAGE_MODEL，绝不落到 DOUBAO_TRANSCRIBE_MODEL
function loadImageConfig(env = process.env) {
  const base = getConfig(env, { timeoutMs: DEFAULT_TIMEOUT_MS });
  return {
    apiKey: base.apiKey,
    baseUrl: base.baseUrl,
    model: (env[MODEL_VAR] ?? "").trim() || DEFAULT_MODEL,
  };
}

function resolveModel(args, config) {
  if (args.model === undefined) return config.model;
  const model = String(args.model).trim();
  if (model === "") {
    throw cliError("E_INVALID_OPTION", "--model 不能为空", {
      option: "--model",
      value: String(args.model),
    });
  }
  return model;
}

function resolveOutput(ctx, raw) {
  if (raw !== undefined && (typeof raw !== "string" || raw.trim() === "")) {
    throw cliError("E_INVALID_OPTION", "--output 不能为空", {
      option: "--output",
      value: String(raw),
    });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(ctx.cwd, raw ?? `doubao-${stamp}.jpeg`);
}

function scrub(text, apiKey) {
  const raw = String(text ?? "");
  return apiKey && apiKey.length > 0 ? raw.split(apiKey).join("***") : raw;
}

// 从 provider 的错误体里摊平出人能读的原因（OpenAI 兼容的 error.message / error / message）
function providerMessageOf(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return "";
  try {
    const payload = JSON.parse(raw);
    const error = payload?.error;
    if (typeof error === "string" && error.trim() !== "") return error.trim();
    if (typeof error?.message === "string" && error.message.trim() !== "") {
      return error.message.trim();
    }
    if (typeof payload?.message === "string" && payload.message.trim() !== "") {
      return payload.message.trim();
    }
  } catch {
    // 非 JSON 响应体，保留原文
  }
  return raw.slice(0, 300);
}

function networkError(err, timeoutMs, action) {
  const timeout = err?.name === "AbortError" || err?.name === "TimeoutError";
  return cliError(
    "E_PROVIDER_ERROR",
    timeout
      ? `doubao ${action}超时（${timeoutMs}ms）`
      : `doubao ${action}网络请求失败：${String(err?.message ?? err)}`,
    { source: SOURCE, reason: timeout ? "timeout" : "network_error" },
  );
}

async function fetchOnce(url, init, timeoutMs, action) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw networkError(err, timeoutMs, action);
  }
}

async function requestGeneration(config, body, timeoutMs) {
  const res = await fetchOnce(
    `${config.baseUrl}/images/generations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    "生图请求",
  );
  const text = await res.text().catch(() => "");
  const message = scrub(providerMessageOf(text), config.apiKey);
  if (res.status === 401 || res.status === 403) {
    throw cliError("E_CONFIG", `DOUBAO_API_KEY 无效或无生图权限（HTTP ${res.status}）`, {
      var: "DOUBAO_API_KEY",
      status: res.status,
      ...(message === "" ? {} : { providerMessage: message }),
    });
  }
  if (!res.ok) {
    throw cliError(
      "E_PROVIDER_ERROR",
      `doubao 生图请求失败（HTTP ${res.status}）${message === "" ? "" : `：${message}`}`,
      {
        source: SOURCE,
        status: res.status,
        ...(message === "" ? {} : { providerMessage: message }),
      },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cliError("E_PROVIDER_ERROR", "doubao 生图响应不是合法 JSON", {
      source: SOURCE,
      reason: "bad_response",
      body: scrub(text.slice(0, 300), config.apiKey),
    });
  }
}

// 结果 URL 是 TOS 签名直链：不携带 Authorization，避免把 key 发给对象存储
async function fetchImageBytes(url, timeoutMs) {
  const res = await fetchOnce(url, { method: "GET" }, timeoutMs, "图片下载");
  if (!res.ok) {
    throw cliError("E_PROVIDER_ERROR", `doubao 图片下载失败（HTTP ${res.status}）`, {
      source: SOURCE,
      status: res.status,
      url,
    });
  }
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw networkError(err, timeoutMs, "图片下载");
  }
}

function imageOf(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : undefined;
  if (typeof item?.b64_json === "string" && item.b64_json !== "") {
    return { buf: Buffer.from(item.b64_json, "base64") };
  }
  if (typeof item?.url === "string" && item.url !== "") {
    return { url: item.url };
  }
  return null;
}

export async function runImageGen(ctx, args) {
  // 本地校验一律先于网络：缺 prompt / 尺寸低于下限 / 超时非法都在这里失败
  const prompt = requirePrompt(args.prompt);
  const requestedSize = parseImageSize(args.size ?? DEFAULT_SIZE);
  const timeoutMs = parseTimeoutMs(args.timeout);

  const config = loadImageConfig(process.env);
  const model = resolveModel(args, config);
  const output = resolveOutput(ctx, args.output);
  // 输出目录不存在也提前拒：别先花掉一次生图额度再报错
  const parent = await stat(path.dirname(output)).catch(() => null);
  if (!parent?.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `输出目录不存在：${path.dirname(output)}`, {
      option: "--output",
      value: output,
    });
  }

  const payload = await requestGeneration(
    config,
    buildImageBody({ model, prompt, size: requestedSize, watermark: args.watermark }),
    timeoutMs,
  );
  const picked = imageOf(payload);
  if (picked === null) {
    const message = scrub(providerMessageOf(JSON.stringify(payload ?? {})), config.apiKey);
    throw cliError(
      "E_PROVIDER_ERROR",
      `doubao 生图响应缺少图片数据${message === "" ? "" : `：${message}`}`,
      {
        source: SOURCE,
        reason: "no_image",
        ...(message === "" ? {} : { providerMessage: message }),
      },
    );
  }
  const buf = picked.buf ?? (await fetchImageBytes(picked.url, timeoutMs));
  await writeFile(output, buf);
  ctx.logger.info(`已写入 ${output}（${buf.length} 字节）`);

  // 契约以真实像素为准：provider 偶尔按自身档位出图，偏差给结构化警告（不失败）
  const meta = await sharp(buf)
    .metadata()
    .catch(() => ({}));
  const actual =
    typeof meta.width === "number" && typeof meta.height === "number"
      ? `${meta.width}x${meta.height}`
      : undefined;
  if (actual !== undefined && actual !== requestedSize) {
    ctx.warnings.add({
      code: "E_SIZE_MISMATCH",
      message: `模型未按请求尺寸出图：请求 ${requestedSize}，实际 ${actual}`,
      plugin: "doubao",
    });
  }

  return {
    path: output,
    bytes: buf.length,
    model,
    size: actual ?? requestedSize,
    requestedSize,
    ...(picked.url === undefined ? {} : { sourceUrl: picked.url }),
    ...(payload?.usage ? { usage: payload.usage } : {}),
  };
}
