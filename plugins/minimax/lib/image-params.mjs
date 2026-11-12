import { parseNumberOption } from "./config.mjs";
import { cliError } from "./errors.mjs";

// minimax-image 的参数解析与请求体构造（本地校验全部发生在 loadConfig()/fetch 之前）。
// 官方契约（platform.minimax.cn，2026-11 核对）：
// - size 走 WxH 时**禁止**同时出现 aspect_ratio / area（连 "auto" 都返回 400）；
// - size 省略或 auto 时才允许 aspect_ratio / area，provider 的 area 默认 4K；
// - disable_prompt_enhanced=true 必须给出显式比例：WxH，或 auto + X:Y。
// 参考图解析在 lib/image.mjs（读盘 + sharp 形状预检）。

export const DEFAULT_SIZE = "1024x1024";
export const DEFAULT_OUTPUT_FORMAT = "jpeg";
export const DEFAULT_TIMEOUT_MS = 600_000;
export const PROMPT_MAX = 32_000;
export const AREAS = ["1K", "2K", "4K"];
export const OUTPUT_FORMATS = ["png", "jpeg", "jpg", "webp"];
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SIZE_RE = /^(\d+)x(\d+)$/;
const RATIO_RE = /^(\d+):(\d+)$/;
// provider：面积 655,360..20,000,000 px（含端点）、宽高比 1:3..3:1（含端点）
const AREA_MIN = 655_360;
const AREA_MAX = 20_000_000;
const SIZE_ASPECT_MAX = 3;
const RATIO_MAX_TERM = 300;

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// "WxH"（正整数，精确输出）或 "auto"；面积/宽高比在本地按 provider 边界拦
export function parseImageSize(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value === "auto") return "auto";
  const match = SIZE_RE.exec(value);
  if (match === null) {
    throw cliError(
      "E_INVALID_OPTION",
      `--size 必须是 WxH（如 ${DEFAULT_SIZE}）或 auto，得到：${raw}`,
      {
        option: "--size",
        value: String(raw),
      },
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw cliError("E_INVALID_OPTION", `--size 的宽高必须是正整数，得到：${raw}`, {
      option: "--size",
      value: String(raw),
    });
  }
  const pixels = width * height;
  if (pixels < AREA_MIN || pixels > AREA_MAX) {
    throw cliError(
      "E_INVALID_OPTION",
      `--size 总像素须在 ${AREA_MIN}–${AREA_MAX} 之间（含端点）：${width}x${height} = ${pixels} px`,
      {
        option: "--size",
        value: `${width}x${height}`,
        width,
        height,
        pixels,
        minArea: AREA_MIN,
        maxArea: AREA_MAX,
      },
    );
  }
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  if (longSide > shortSide * SIZE_ASPECT_MAX) {
    throw cliError(
      "E_INVALID_OPTION",
      `--size 宽高比须在 1:3–3:1 之间（含端点）：${width}x${height} 为 ${(longSide / shortSide).toFixed(3)}:1`,
      { option: "--size", value: `${width}x${height}`, width, height, maxAspect: SIZE_ASPECT_MAX },
    );
  }
  return `${width}x${height}`;
}

// "auto" 或 X:Y（X,Y 为 1..300 的整数，比例 1:3..3:1）
export function parseAspectRatio(raw) {
  const value = optionalText(raw);
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "auto") return "auto";
  const match = RATIO_RE.exec(value);
  if (match === null) {
    throw cliError(
      "E_INVALID_OPTION",
      `--aspect-ratio 必须是 X:Y（如 16:9）或 auto，得到：${value}`,
      {
        option: "--aspect-ratio",
        value,
      },
    );
  }
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 1 ||
    x > RATIO_MAX_TERM ||
    y < 1 ||
    y > RATIO_MAX_TERM
  ) {
    throw cliError(
      "E_INVALID_OPTION",
      `--aspect-ratio 的 X/Y 必须是 1–${RATIO_MAX_TERM} 的整数，得到：${value}`,
      { option: "--aspect-ratio", value },
    );
  }
  const longTerm = Math.max(x, y);
  const shortTerm = Math.min(x, y);
  if (longTerm > shortTerm * SIZE_ASPECT_MAX) {
    throw cliError(
      "E_INVALID_OPTION",
      `--aspect-ratio 须在 1:3–3:1 之间（含端点），得到：${value}`,
      {
        option: "--aspect-ratio",
        value,
      },
    );
  }
  return `${x}:${y}`;
}

// provider 只收 1K/2K/4K（目标 1024²/2048²/4096²），大小写归一
export function parseArea(raw) {
  const value = optionalText(raw);
  if (value === undefined) return undefined;
  const area = value.toUpperCase();
  if (!AREAS.includes(area)) {
    throw cliError("E_INVALID_OPTION", `--area 仅支持 ${AREAS.join(" | ")}，得到：${value}`, {
      option: "--area",
      value,
    });
  }
  return area;
}

// jpg 归一到 jpeg（落盘扩展名与回执都用 jpeg）；其余枚举原样校验
export function normalizeOutputFormat(raw) {
  const value = optionalText(raw)?.toLowerCase() ?? DEFAULT_OUTPUT_FORMAT;
  const format = value === "jpg" ? "jpeg" : value;
  if (!["png", "jpeg", "webp"].includes(format)) {
    throw cliError(
      "E_INVALID_OPTION",
      `--output-format 仅支持 ${OUTPUT_FORMATS.join(" | ")}，得到：${value}`,
      { option: "--output-format", value },
    );
  }
  return format;
}

// 未显式传 --size 时：有 area/aspect 提示走 auto（否则它们会被 provider 拒），
// 都没有则用命令的显式默认 1024x1024，保证输出可预期
function resolveSize(rawSize, hasAutoHints) {
  const value = optionalText(rawSize);
  if (value === undefined) return hasAutoHints ? "auto" : DEFAULT_SIZE;
  return parseImageSize(value);
}

export function parseImageArgs(args = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (prompt === "") {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --prompt", { option: "--prompt" });
  }
  // 按 Unicode 码点计数：汉字与常用标点各算 1
  const chars = Array.from(prompt).length;
  if (chars > PROMPT_MAX) {
    throw cliError("E_INVALID_OPTION", `--prompt 超过 ${PROMPT_MAX} 字符（当前 ${chars}）`, {
      option: "--prompt",
      limit: PROMPT_MAX,
      actual: chars,
    });
  }

  const aspectRatio = parseAspectRatio(args.aspectRatio);
  const area = parseArea(args.area);
  const hasAutoHints = aspectRatio !== undefined || area !== undefined;
  const size = resolveSize(args.size, hasAutoHints);
  if (size !== "auto" && hasAutoHints) {
    const option = area !== undefined ? "--area" : "--aspect-ratio";
    throw cliError(
      "E_INVALID_OPTION",
      `${option} 只能与 --size auto（或省略 --size）搭配：显式 WxH 时 provider 禁止同时传 aspect_ratio/area（连 auto 都会 400）`,
      { option, value: size, reason: "size_conflict" },
    );
  }

  const disablePromptEnhanced = args.disablePromptEnhanced === true;
  const hasExplicitRatio = aspectRatio !== undefined && aspectRatio !== "auto";
  if (disablePromptEnhanced && size === "auto" && !hasExplicitRatio) {
    throw cliError(
      "E_INVALID_OPTION",
      "--disable-prompt-enhanced 要求显式输出比例：请传 --size WxH，或 --size auto 配 --aspect-ratio X:Y",
      { option: "--disable-prompt-enhanced", reason: "missing_explicit_ratio" },
    );
  }

  const outputCompression = parseNumberOption(args.outputCompression, "--output-compression", {
    min: 0,
    max: 100,
    integer: true,
    fallback: undefined,
  });
  const timeoutMs = parseNumberOption(args.timeout, "--timeout", {
    min: 1,
    integer: true,
    fallback: DEFAULT_TIMEOUT_MS,
  });

  return {
    prompt,
    size,
    sizeMode: size === "auto" ? "auto" : "explicit",
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(area === undefined ? {} : { area }),
    disablePromptEnhanced,
    outputFormat: normalizeOutputFormat(args.outputFormat),
    ...(outputCompression === undefined ? {} : { outputCompression }),
    aigcWatermark: args.aigcWatermark === true,
    timeoutMs,
  };
}

// 只发用户显式选择的字段：provider 默认值（response_format / n / stream /
// disable_prompt_enhanced=false / output_compression=95 …）一律不铺进请求体
export function buildImageBody(input, refs) {
  return {
    model: input.model,
    prompt: input.prompt,
    size: input.size,
    output_format: input.outputFormat,
    ...(input.aspectRatio === undefined ? {} : { aspect_ratio: input.aspectRatio }),
    ...(input.area === undefined ? {} : { area: input.area }),
    ...(input.disablePromptEnhanced === true ? { disable_prompt_enhanced: true } : {}),
    ...(input.outputCompression === undefined
      ? {}
      : { output_compression: input.outputCompression }),
    ...(input.aigcWatermark === true ? { aigc_watermark: true } : {}),
    ...(refs === undefined || refs.length === 0
      ? {}
      : { images: refs.map((item) => ({ image_url: item.url })) }),
  };
}

// base64 精确放大按 4/3 向上取整；整个 JSON 请求体须 ≤64MB（见 lib/image.mjs 的 --ref）
export function assertBodyBudget(inlinedBytes) {
  const base64Bytes = Math.ceil(inlinedBytes / 3) * 4;
  if (base64Bytes > MAX_BODY_BYTES) {
    throw cliError(
      "E_INVALID_OPTION",
      `内联参考图 base64 后约 ${(base64Bytes / 1024 / 1024).toFixed(1)}MB，超过 provider 的 64MB 请求体上限：请改传公网 URL、mm_file:// 或拆分请求`,
      { option: "--ref", inlinedBytes, base64Bytes, maxBodyBytes: MAX_BODY_BYTES },
    );
  }
}
