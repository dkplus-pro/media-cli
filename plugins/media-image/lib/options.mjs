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
