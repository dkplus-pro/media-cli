import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getConfig } from "./config.mjs";
import { cliError } from "./errors.mjs";
import {
  fetchImageBytes,
  imageOf,
  providerMessageOf,
  requestGeneration,
  SOURCE,
  scrub,
} from "./image-client.mjs";
import { resolveRefs, summarizeRefs } from "./image-refs.mjs";

// 火山方舟生图（media-08 / D42）：POST /images/generations → TOS 签名 URL → 不带 Authorization 下载落盘。
// 与转写/视觉不同，这里不复用 lib/ark.mjs 的 chatWithRetry：端点与响应形态都不同，
// 且生图没有「空内容」概念。错误码只复用已登记的 E_CONFIG / E_PROVIDER_ERROR /
// E_MISSING_ARGUMENT / E_INVALID_OPTION（D43），细节放 details。
// 本文件只做参数解析与编排：HTTP 与错误摊平在 lib/image-client.mjs，参考图（图生图）
// 解析在 lib/image-refs.mjs——图生图与文生图共用本端点与本模型，只多一个 `image` 字段。

const DEFAULT_MODEL = "doubao-seedream-4-5-251128";
const MODEL_VAR = "DOUBAO_IMAGE_MODEL";
const DEFAULT_SIZE = "2048x2048";
const DEFAULT_TIMEOUT_MS = 180_000;
// 官方模型详情页（控制台 doubao-seedream-4-5）写的分辨率区间 2560*1440 – 4096*4096，
// 两端均已实测为总像素口径：1920x1920 与 2560x1440 都恰好 3,686,400 px 通过，
// 1024x1024 报 "must be at least 3686400 pixels"、8192x8192 报 "must be at most 16777216 pixels"。
// 本地先拦两端：省一次往返，且报错比 provider 的英文原文可读。
const MIN_PIXELS = 3_686_400;
const MAX_PIXELS = 16_777_216;
const SIZE_RE = /^(\d{3,5})x(\d{3,5})$/;

function requirePrompt(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  return value.trim();
}

// 只收 WxH（provider 实测格式）；总像素越出区间本地即拒，绝不发网络
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
  if (pixels > MAX_PIXELS) {
    throw cliError(
      "E_INVALID_OPTION",
      `--size 总像素不得多于 ${MAX_PIXELS}（provider 实测上限 = 4096x4096，${raw} 有 ${pixels} px）`,
      { option: "--size", value: raw, pixels, maxPixels: MAX_PIXELS },
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

// 请求体字段全部为实测被接受的最小集：url 取件、默认不加水印、关掉组图（一次一张）。
// refs 为空时**一个字段都不加**（保持文生图请求体与 media-31 完全一致）；
// 单张传字符串、多张传数组——官方给的类型就是 string / string[]，两种形态均实测被接受。
export function buildImageBody({ model, prompt, size, watermark, refs = [] }) {
  return {
    model,
    prompt,
    size,
    response_format: "url",
    watermark: watermark === true,
    sequential_image_generation: "disabled",
    ...(refs.length === 0 ? {} : { image: refs.length === 1 ? refs[0] : refs }),
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

export async function runImageGen(ctx, args) {
  // 本地校验一律先于网络：缺 prompt / 尺寸越界 / 超时非法 / 参考图读不到都在这里失败
  const prompt = requirePrompt(args.prompt);
  const requestedSize = parseImageSize(args.size ?? DEFAULT_SIZE);
  const timeoutMs = parseTimeoutMs(args.timeout);
  const refs = await resolveRefs(args.ref, ctx.cwd);

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
    buildImageBody({ model, prompt, size: requestedSize, watermark: args.watermark, refs }),
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
    // 只回摘要：base64 原文进 stdout 既灌爆输出，也把参考图像素带进命令结果
    ...(refs.length === 0 ? {} : { refs: summarizeRefs(refs) }),
    ...(picked.url === undefined ? {} : { sourceUrl: picked.url }),
    ...(payload?.usage ? { usage: payload.usage } : {}),
  };
}
