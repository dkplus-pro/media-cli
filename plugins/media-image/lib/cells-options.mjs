import { DEFAULT_MAX_OVERLAP, MAX_OVERLAP_MAX, MAX_OVERLAP_MIN } from "./cells-geometry.mjs";
import { cliError } from "./errors.mjs";
import { parseColor, parseFontSize, parseOpacity } from "./options.mjs";

// media-grid-caption 的 CLI 选项校验（§6.2 选项表）。
// 与 cells-io.mjs 分开放：那里只管 §2 冻结的 cells JSON 语义，这边只管命令行怎么落值。

const MAX_SIDE = 64;

function invalidOption(option, expected, raw) {
  return cliError("E_INVALID_OPTION", `${option} ${expected}，得到：${raw}`, {
    option,
    value: String(raw),
  });
}

function parseIntIn(raw, option, fallback, min, max) {
  if (raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalidOption(option, `必须是 ${min}-${max} 的整数`, raw);
  }
  return n;
}

// 复用 options.mjs 的 COLOR_RE（parseColor 里那条白名单），只把报错文案换成实际选项名
function parseColorOption(raw, option, fallback) {
  if (raw === undefined) return fallback;
  try {
    return parseColor(raw, fallback);
  } catch {
    throw invalidOption(option, "必须是 CSS 颜色值（如 #FFFFFF 或 rgb(255,255,255)）", raw);
  }
}

function parsePosition(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value !== "bottom" && value !== "top") {
    throw invalidOption("--position", "只能是 bottom | top", raw);
  }
  return value;
}

// --max-overlap：重叠分级阈值（占较小格面积的比重）。0 合法（一点重叠都不放过 → 全按硬错）。
function parseMaxOverlap(raw) {
  if (raw === undefined) return DEFAULT_MAX_OVERLAP;
  const n = Number(raw);
  // 空值要拒：Number("") === 0，会让用户以为「阈值 0 = 放行」，实际是全按硬错
  if (typeof raw !== "number" && String(raw).trim() === "") {
    throw invalidOption(
      "--max-overlap",
      `必须是 ${MAX_OVERLAP_MIN}-${MAX_OVERLAP_MAX} 之间的小数`,
      raw,
    );
  }
  if (!Number.isFinite(n) || n < MAX_OVERLAP_MIN || n > MAX_OVERLAP_MAX) {
    throw invalidOption(
      "--max-overlap",
      `必须是 ${MAX_OVERLAP_MIN}-${MAX_OVERLAP_MAX} 之间的小数（重叠面积占较小格面积的比重；默认 ${DEFAULT_MAX_OVERLAP}）`,
      raw,
    );
  }
  return Math.round(n * 10000) / 10000;
}

// --cols/--rows 必须成对给出（等分语义缺一半就没意义）
function parseDivision(args) {
  const hasCols = args.cols !== undefined;
  const hasRows = args.rows !== undefined;
  if (!hasCols && !hasRows) return null;
  if (!hasCols || !hasRows) {
    throw cliError(
      "E_INVALID_OPTION",
      "--cols 与 --rows 必须同时给出（等分宫格需要两个方向都指定）",
      { option: hasCols ? "--rows" : "--cols" },
    );
  }
  return {
    cols: parseIntIn(args.cols, "--cols", 1, 1, MAX_SIDE),
    rows: parseIntIn(args.rows, "--rows", 1, 1, MAX_SIDE),
  };
}

export function parseGridCaptionArgs(args) {
  return {
    input: args.input === undefined ? "" : String(args.input),
    cellsPath: args.cells === undefined ? null : String(args.cells),
    captionsPath: args.captions === undefined ? null : String(args.captions),
    division: parseDivision(args),
    // 本地自动检测默认开启；--no-locate 关闭（commander 的 negate 语义）
    locate: args.locate !== false,
    font:
      typeof args.font === "string" && args.font.trim() !== "" ? args.font.trim() : "sans-serif",
    fontSize: parseFontSize(args.fontSize) ?? null,
    textColor: parseColorOption(args.textColor, "--text-color", "#FFFFFF"),
    opacity: parseOpacity(args.opacity, 0.1),
    padding: parseIntIn(args.padding, "--padding", 12, 0, 512),
    position: parsePosition(args.position, "bottom"),
    // 选项名沿用 --flat-tol，语义已按修正后的算法改成「与背景灰度的容差」（§6.2 bgTol，默认 24）
    bgTol: parseIntIn(args.flatTol, "--flat-tol", 24, 0, 255),
    minGutter: parseIntIn(args.minGutter, "--min-gutter", 3, 0, 256),
    // 重叠格分级（F2/F3）：≤ maxOverlap 只警告，> 它才 E_INVALID_OPTION；--allow-overlap 全放行
    allowOverlap: args.allowOverlap === true,
    maxOverlap: parseMaxOverlap(args.maxOverlap),
    output: args.output === undefined ? null : String(args.output),
  };
}
