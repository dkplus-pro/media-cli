import { autoFontSize, measureText } from "./watermark.mjs";

// 自动字号 + 自动换行（§6.2）。测量一律走 watermark.mjs 的 measureText
// —— 与正式渲染同一管线（sharp/librsvg），测量即所见，不会出现算完放不下又硬塞。

export const LINE_HEIGHT_FACTOR = 1.35;
export const MAX_LINES = 4;
export const MIN_FONT_SIZE = 14;
const ELLIPSIS = "…";

// 兜底版式的起始字号：按整图宽算（§6.2「字号自动（按整图宽）」），但在 autoFontSize
// 的最短边 1/24 之上再收一档（宽 1/48）—— 2048 宽图直接用 1/24 会得到 85px 的巨型字幕条
export function fallbackStartFontSize(width, height) {
  const cap = Math.max(18, Math.round(width / 48));
  return Math.max(MIN_FONT_SIZE, Math.min(autoFontSize(width, height), cap));
}

function segments(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// 测量缓存：同一次布局里「字号 + 文本」只测一次 —— 折行与字号二分会反复量同一串
function createMeasurer(sharp, style) {
  const cache = new Map();
  const keyOf = (text, fontSize) => `${fontSize}|${text}`;
  return async function measure(text, fontSize) {
    if (text === "") return 0;
    const key = keyOf(text, fontSize);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const box = await measureText(sharp, { ...style, text, fontSize });
    cache.set(key, box.width);
    return box.width;
  };
}

// 按字符折行：先用整行实测宽度反推平均字宽定切点，再逐段实测校核（超宽就逐字回退）。
// 中文近似等宽，所以平均字宽已经很准；混排拉丁/数字时靠校核兜住。
export async function wrapLine(measure, line, maxWidth, fontSize) {
  const out = [];
  if (line === "") return { lines: out, overflow: false };
  const fullWidth = await measure(line, fontSize);
  if (fullWidth <= maxWidth) return { lines: [line], overflow: false };

  const chars = [...line];
  const avg = fullWidth / chars.length;
  const perChunk = Math.max(1, Math.floor(maxWidth / avg));
  let overflow = false;
  let i = 0;
  while (i < chars.length) {
    let chunk = chars.slice(i, i + perChunk);
    let width = await measure(chunk.join(""), fontSize);
    while (width > maxWidth && chunk.length > 1) {
      chunk = chunk.slice(0, -1);
      width = await measure(chunk.join(""), fontSize);
    }
    if (width > maxWidth) overflow = true; // 连一个字都放不下
    out.push(chunk.join(""));
    i += Math.max(1, chunk.length);
  }
  return { lines: out, overflow };
}

// 末尾省略号：截到放不下为止，再补一个 …（§6.2「行数上限 4 行，再多则截断加 …」）
async function withEllipsis(measure, text, maxWidth, fontSize) {
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join("")}${ELLIPSIS}`;
    if ((await measure(candidate, fontSize)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, Math.max(0, lo)).join("")}${ELLIPSIS}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 单条字幕的换行结果（不含字号决策）：超过 maxLines 就截到 maxLines 并以 … 收尾
async function wrapAtSize(measure, text, { maxWidth, fontSize, maxLines }) {
  let lines = [];
  let overflow = false;
  for (const seg of segments(text)) {
    const wrapped = await wrapLine(measure, seg, maxWidth, fontSize);
    if (wrapped.overflow) overflow = true;
    lines = lines.concat(wrapped.lines);
  }
  if (lines.length > maxLines) {
    const rest = lines.slice(maxLines - 1).join("");
    const tail = await withEllipsis(measure, rest, maxWidth, fontSize);
    lines = maxLines === 1 ? [tail] : [...lines.slice(0, maxLines - 1), tail];
    overflow = true;
  }
  return { lines, overflow };
}

// 给定字号排一条字幕：返回行数组、行高、黑条高，以及 fits（能否完整放下）
export async function planAtFontSize(
  measure,
  text,
  { maxWidth, maxHeight, padding, fontSize, maxLines },
) {
  const { lines, overflow } = await wrapAtSize(measure, text, { maxWidth, fontSize, maxLines });
  const lineHeight = round2(fontSize * LINE_HEIGHT_FACTOR);
  const barHeight = round2(lines.length * lineHeight + 2 * padding);
  const fits =
    lines.length > 0 &&
    !overflow &&
    lines.length <= maxLines &&
    (maxHeight === undefined || maxHeight === null || barHeight <= maxHeight);
  return { fontSize, lines, lineHeight, barHeight, overflow, fits };
}

// 单条字幕布局：在 [minFontSize, startFontSize] 里二分找「最大且能完整放下」的字号；
// 全档都放不下就退到最小字号并截断加 …（truncated=true，由调用方发 E_TEXT_TRUNCATED 警告）。
// 显式 fontSize（用户传 --font-size）不参与二分：字号照用户说的用，放不下就截断。
export async function layoutCaption(sharp, options) {
  const {
    text,
    font,
    color = "#FFFFFF",
    opacity = 1,
    maxWidth,
    maxHeight,
    startFontSize,
    fontSize: forced = null,
    minFontSize = MIN_FONT_SIZE,
    maxLines = MAX_LINES,
    padding = 0,
  } = options;
  const avail = Math.max(1, Math.floor(maxWidth - 2 * padding));
  const measure = createMeasurer(sharp, { font, color, opacity });
  const lo = Math.max(MIN_FONT_SIZE, Math.round(minFontSize));
  const start = Math.max(lo, Math.round(forced ?? startFontSize));
  const box = { maxWidth: avail, maxHeight, padding, maxLines };

  if (segments(text).length === 0) {
    return {
      fontSize: start,
      lines: [],
      lineHeight: 0,
      barHeight: 0,
      fits: false,
      truncated: false,
      empty: true,
    };
  }
  if (forced !== null) {
    const plan = await planAtFontSize(measure, text, { ...box, fontSize: start });
    return { ...plan, truncated: !plan.fits };
  }
  const atStart = await planAtFontSize(measure, text, { ...box, fontSize: start });
  if (atStart.fits) return { ...atStart, truncated: false };

  let low = lo;
  let high = start - 1;
  let best = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const plan = await planAtFontSize(measure, text, { ...box, fontSize: mid });
    if (plan.fits) {
      best = plan;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best) return { ...best, truncated: false };
  const fallback = await planAtFontSize(measure, text, { ...box, fontSize: lo });
  return { ...fallback, truncated: true };
}

// 兜底版式（fallback-bottom）：N 条字幕按 index 顺序逐条换行后堆进同一条黑条，
// 字号取「所有字幕都完整放得下」的最大档（整图宽内折行，黑条向下扩所以不设高度上限）
export async function layoutFallbackStack(sharp, options) {
  const {
    texts,
    width,
    height,
    font,
    color = "#FFFFFF",
    opacity = 1,
    padding = 0,
    fontSize: forced = null,
    maxLines = MAX_LINES,
  } = options;
  const avail = Math.max(1, Math.floor(width - 2 * padding));
  const measure = createMeasurer(sharp, { font, color, opacity });
  const lo = MIN_FONT_SIZE;
  const start = Math.max(lo, Math.round(forced ?? fallbackStartFontSize(width, height)));
  const box = { maxWidth: avail, maxHeight: null, padding, maxLines };

  async function planAll(fontSize) {
    const blocks = [];
    for (const text of texts) {
      blocks.push(await planAtFontSize(measure, text, { ...box, fontSize }));
    }
    const lines = blocks.reduce((n, b) => n + b.lines.length, 0);
    const lineHeight = round2(fontSize * LINE_HEIGHT_FACTOR);
    return {
      fontSize,
      blocks,
      lines,
      lineHeight,
      barHeight: round2(lines * lineHeight + 2 * padding),
      fits: lines > 0 && blocks.every((b) => b.fits),
    };
  }

  let chosen = null;
  if (forced !== null) {
    // 用户显式指定字号：不二分，直接按该字号排，放不下就截断
    const stack = await planAll(Math.max(lo, Math.round(forced)));
    return { ...stack, truncated: !stack.fits };
  }
  if ((await planAll(start)).fits) {
    chosen = start;
  } else {
    let low = lo;
    let high = start - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if ((await planAll(mid)).fits) {
        chosen = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  }
  const stack = await planAll(chosen ?? lo);
  return { ...stack, truncated: chosen === null };
}
