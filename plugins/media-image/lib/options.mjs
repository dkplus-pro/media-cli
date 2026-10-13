import { cliError } from "./errors.mjs";

function invalid(option, expected, raw) {
  return cliError("E_INVALID_OPTION", `${option} ${expected}，得到：${raw}`, {
    option,
    value: raw,
  });
}

export function parseQuality(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw invalid("--quality", "必须是 1-100 的整数", raw);
  }
  return n;
}

export function parseOpacity(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw invalid("--opacity", "必须是 (0, 1] 的小数，如 0.3", raw);
  }
  return n;
}

export function parseAngle(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > 360) {
    throw invalid("--angle", "必须是 -360 到 360 的角度值", raw);
  }
  return n;
}

export function parseSpacing(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < 0) {
    throw invalid("--spacing", "必须是非负整数（像素）", raw);
  }
  return n;
}

// 未传返回 undefined → 调用方按图片尺寸自适应
export function parseFontSize(raw) {
  if (raw === undefined) return undefined;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < 6 || n > 1000) {
    throw invalid("--font-size", "必须是 6-1000 的整数（像素）", raw);
  }
  return n;
}

// 白名单字符集，防止颜色值注入 SVG 属性
const COLOR_RE = /^[#A-Za-z0-9(),.\s%-]{1,64}$/;

export function parseColor(raw, fallback) {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !COLOR_RE.test(raw)) {
    throw invalid("--color", "必须是 CSS 颜色值（如 #ffffff 或 rgb(255,255,255)）", raw);
  }
  return raw;
}

export function parseText(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --text（水印文案）", { option: "--text" });
  }
  return raw.trim();
}

function parseEnum(raw, allowed, option, fallback) {
  if (raw === undefined) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw invalid(option, `只能是 ${allowed.join("|")} 之一`, raw);
  }
  return value;
}

function parseBoundedInt(raw, option, fallback, min, max, unit) {
  if (raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalid(option, `必须是 ${min}-${max} 的整数${unit}`, raw);
  }
  return n;
}

// 页面顺序：natural = 文件名自然序（page2 在 page10 前），lexicographic = 纯字典序
export function parseOrder(raw) {
  return parseEnum(raw, ["natural", "lexicographic"], "--order", "natural");
}

// 页面尺寸：image 贴合图片，a4/letter 固定页面
export function parsePageSize(raw) {
  return parseEnum(raw, ["image", "a4", "letter"], "--page", "image");
}

export function parseOrientation(raw) {
  return parseEnum(raw, ["auto", "portrait", "landscape"], "--orientation", "auto");
}

// PDF 内图片编码：jpeg 体积小且不支持透明（自动压白底），png 保留细节与 alpha
export function parseImageFormat(raw) {
  return parseEnum(raw, ["jpeg", "png"], "--image-format", "jpeg");
}

export function parseDpi(raw) {
  return parseBoundedInt(raw, "--dpi", 300, 72, 1200, "（像素每英寸）");
}

export function parseMargin(raw) {
  return parseBoundedInt(raw, "--margin", 0, 0, 200, "（磅 pt，仅固定页面生效）");
}
