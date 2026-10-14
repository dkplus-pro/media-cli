import { readFile } from "node:fs/promises";
import { DEFAULT_MAX_OVERLAP, findCellOverlaps, overlapError } from "./cells-geometry.mjs";
import { cliError } from "./errors.mjs";

// cells JSON 的读取 + §2 校验（media-grid-caption 侧，字段名冻结）。
// 这里执行的是**严格**校验：--cells 是人或视觉模型产出的输入，任何不合规都当场 E_INVALID_OPTION
// 并把出错的 cell index 带出来，绝不静默裁剪、绝不"差不多就行"。
// **唯一有刻度的例外是重叠**（F2/F3）：视觉模型的坐标来自降采样的小图，放大回原图必然带 ±1px 的
// 薄条重叠 —— 那是这条链的固有产物，所以按 --max-overlap 分级：阈值内只发 E_CELLS_OVERLAP **警告**
// 并照常渲染，超了才硬拒；--allow-overlap 两者都压掉。
// （doubao/lib/grid-schema.mjs 是另一套：那里对视觉模型的常见毛病做有记录的宽容。）

const SOURCES = ["vision", "auto", "manual"];
// §2 的 source 枚举里唯一不属于「定位方式」的值：三级定位全失败、走整图底部外扩兜版式
export const SOURCE_NONE = "none";
const ALIGNS = ["left", "center", "right"];
const POSITIONS = ["bottom", "top"];
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 1000;

// 几何交叉检查住在 cells-geometry.mjs，这里再导出一次：--cells 的校验入口只有这一个门面
export {
  DEFAULT_MAX_OVERLAP,
  findCellOverlaps,
  overlapWarningText,
} from "./cells-geometry.mjs";

function invalid(details, message, extra = {}) {
  return cliError("E_INVALID_OPTION", message, { ...details, ...extra });
}

function badCell(option, cell, message) {
  return invalid({ option, cell }, `cells JSON 不合规：${message}`);
}

// --cells 顶层是对象；--captions 顶层可以是数组（§6.2 的两种入口形态不同）
export function parseJsonDocument(text, option, { allowArray = false } = {}) {
  try {
    const value = JSON.parse(text);
    const isObject = value !== null && typeof value === "object";
    if (!isObject || (!allowArray && Array.isArray(value))) {
      throw new Error(allowArray ? "顶层必须是对象或数组" : "顶层必须是对象");
    }
    return value;
  } catch (err) {
    throw invalid(
      { option, reason: "not_json" },
      `${option} 不是合法 JSON 文档（${err?.message ?? err}）：请用 doubao-grid-locate --output 生成，或手工按 §2 schema 编写`,
    );
  }
}

// §2 规则 5：image.width/height 必须存在、是正整数，并与实际解码出的尺寸一致
function readImageBlock(doc, option, actual) {
  const image = doc?.image;
  const width = image?.width;
  const height = image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw invalid(
      { option, reason: "missing_image_size" },
      `${option} 缺少合法的 image.width/height（必填的正整数像素尺寸）`,
    );
  }
  if (width !== actual.width || height !== actual.height) {
    throw invalid(
      { option, reason: "image_size_mismatch", cells: { width, height }, actual },
      `${option} 是为 ${width}x${height} 的图生成的，与当前图片 ${actual.width}x${actual.height} 不符`,
    );
  }
  return { width, height };
}

function readStyle(cell, option) {
  const out = {};
  if (cell.text !== undefined) {
    if (typeof cell.text !== "string") {
      throw badCell(option, cell.index, "text 必须是字符串");
    }
    out.text = cell.text;
  }
  if (cell.fontSize !== undefined) {
    const size = cell.fontSize;
    if (!Number.isInteger(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) {
      throw badCell(option, cell.index, `fontSize 必须是 ${FONT_SIZE_MIN}-${FONT_SIZE_MAX} 的整数`);
    }
    out.fontSize = size;
  }
  if (cell.align !== undefined) {
    if (typeof cell.align !== "string" || !ALIGNS.includes(cell.align.toLowerCase())) {
      throw badCell(option, cell.index, `align 只能是 ${ALIGNS.join("/")} 之一`);
    }
    out.align = cell.align.toLowerCase();
  }
  if (cell.position !== undefined) {
    if (typeof cell.position !== "string" || !POSITIONS.includes(cell.position.toLowerCase())) {
      throw badCell(option, cell.index, `position 只能是 ${POSITIONS.join("/")} 之一`);
    }
    out.position = cell.position.toLowerCase();
  }
  return out;
}

// §2 规则 1–4（规则 5 在 readImageBlock 里，需要外部真实尺寸）+ F3/F2 的重叠分级
// 返回 overlaps：severe 已经在 overlapError 里抛掉了，这里剩下的全是「只警告」的小重叠
export function validateCells(
  doc,
  { actual, option = "--cells", allowOverlap = false, maxOverlap = DEFAULT_MAX_OVERLAP } = {},
) {
  if (Array.isArray(doc)) {
    throw invalid(
      { option, reason: "not_object" },
      `${option} 顶层必须是含 cells 的对象（doubao-grid-locate 的输出即此形态）；只有文本数组请用 --captions`,
    );
  }
  const image = readImageBlock(doc, option, actual);
  const list = doc?.cells;
  if (!Array.isArray(list) || list.length === 0) {
    throw invalid({ option, reason: "empty_cells" }, `${option} 的 cells 必须是非空数组`);
  }

  const seen = new Set();
  const cells = [];
  for (let i = 0; i < list.length; i += 1) {
    const cell = list[i];
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) {
      throw invalid({ option, cell: i }, `${option} 第 ${i} 项必须是对象`);
    }
    const { index, x, y, w, h } = cell;
    if (!Number.isInteger(index) || index < 0) {
      throw invalid({ option, cell: i }, `${option} 第 ${i} 项的 index 必须是从 0 开始的整数`);
    }
    if (seen.has(index)) {
      throw badCell(option, index, `index ${index} 重复`);
    }
    seen.add(index);
    // 规则 2：有限整数 + 宽高为正
    for (const [key, value] of [
      ["x", x],
      ["y", y],
      ["w", w],
      ["h", h],
    ]) {
      if (!Number.isInteger(value)) {
        throw badCell(
          option,
          index,
          `${key} 必须是有限整数（不接受小数/归一化坐标，得到：${value}）`,
        );
      }
    }
    if (w <= 0 || h <= 0) throw badCell(option, index, `w/h 必须大于 0（得到 ${w}x${h}）`);
    if (x < 0 || y < 0) throw badCell(option, index, `x/y 不能为负（得到 ${x},${y}）`);
    // 规则 3：越界即拒，不静默裁剪
    if (x + w > image.width || y + h > image.height) {
      throw badCell(
        option,
        index,
        `第 ${index} 格越界：x=${x} y=${y} w=${w} h=${h} 超出画布 ${image.width}x${image.height}`,
      );
    }
    cells.push({ index, x, y, w, h, ...readStyle(cell) });
  }

  // F3 + F2：§2 五条规则之外的第六道关 —— 重叠格子会让同一格被画上两条字幕。
  // 大幅重叠硬拒（overlapError 里按 maxOverlap 判），小重叠只带回去发警告（消费侧不静默、也不打回）
  const overlap = overlapError(cells, { option, allowOverlap, maxOverlap });
  if (overlap) throw overlap;
  const overlaps = allowOverlap
    ? { total: 0, minor: [], severe: [], maxOverlap }
    : findCellOverlaps(cells, { maxOverlap });

  const source = SOURCES.includes(doc?.source) ? doc.source : "manual";
  return { cells, image, source, overlaps };
}

// --captions：只有文本与样式，按 index 与 cells 合并
export function validateCaptions(doc, { option = "--captions" } = {}) {
  const list = Array.isArray(doc) ? doc : doc?.captions;
  if (!Array.isArray(list)) {
    throw invalid(
      { option, reason: "not_array" },
      `${option} 必须是数组（[{index,text,fontSize?,align?}]），或含 captions 数组的对象`,
    );
  }
  const seen = new Set();
  const items = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item === null || typeof item !== "object") {
      throw invalid({ option, cell: i }, `${option} 第 ${i} 项必须是对象`);
    }
    const index = Number.isInteger(item.index) ? item.index : i;
    if (seen.has(index)) {
      throw invalid({ option, cell: index }, `${option} 的 index ${index} 重复`);
    }
    seen.add(index);
    if (typeof item.text !== "string") {
      throw invalid({ option, cell: index }, `${option} 第 ${index} 项的 text 必须是字符串`);
    }
    items.push({ index, ...readStyle({ ...item, index }, option) });
  }
  return items;
}

// 合并：--captions 覆盖 --cells 里的同 index 文本；条数不匹配由调用方发 E_PARTIAL_INPUT 警告
export function mergeCaptions(cells, captions) {
  const byIndex = new Map(cells.map((cell) => [cell.index, { ...cell }]));
  const matched = new Set();
  const droppedIndexes = [];
  for (const item of captions) {
    const cell = byIndex.get(item.index);
    if (!cell) {
      droppedIndexes.push(item.index);
      continue;
    }
    byIndex.set(item.index, { ...cell, ...item });
    matched.add(item.index);
  }
  const merged = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const missingCells = merged
    .filter((c) => !(typeof c.text === "string" && c.text.trim() !== ""))
    .map((c) => c.index);
  const withText = merged.length - missingCells.length;
  return {
    cells: merged,
    withText,
    cellCount: merged.length,
    missingCells,
    droppedIndexes,
    matchedCaptions: matched.size,
    droppedCaptions: captions.length - matched.size,
  };
}

// --cols/--rows 等分（优先级第 2 级，跳过检测）
export function buildEqualCells(width, height, cols, rows) {
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      // 用 ceil/floor 组合保证最后一格贴住右/下边，且每格宽高至少 1
      const x = Math.round((width * c) / cols);
      const nextX = c + 1 === cols ? width : Math.round((width * (c + 1)) / cols);
      const y = Math.round((height * r) / rows);
      const nextY = r + 1 === rows ? height : Math.round((height * (r + 1)) / rows);
      cells.push({ index: r * cols + c, x, y, w: nextX - x, h: nextY - y });
    }
  }
  return cells;
}

export async function readJsonFile(file, option, { allowArray = false } = {}) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw invalid(
      { option, reason: "unreadable" },
      `${option} 读不到：${file}（${err?.code ?? err?.message ?? err}）`,
    );
  }
  return parseJsonDocument(text, option, { allowArray });
}

// ---------- 字幕与格子的条数关系（§6.2「条数不匹配只警告不失败」） ----------

// 一条字幕对不上格、或者有格没字幕，都只算「部分输入」；必须合成**一条**自洽的警告，
// 不能一边按匹配数说「少于格数」一边按未匹配数说「多于格数」（F6 的实测矛盾）
export function describePartialInput(merged) {
  const missing = merged.missingCells;
  const dropped = merged.droppedIndexes;
  if (missing.length === 0 && dropped.length === 0) return null;
  const parts = [];
  if (missing.length > 0) {
    parts.push(
      `${merged.cellCount} 格里有 ${missing.length} 格没有字幕文本（index ${missing.join("/")}，这些格保持干净）`,
    );
  }
  if (dropped.length > 0) {
    parts.push(`${dropped.length} 条字幕找不到对应格（index ${dropped.join("/")}，已忽略）`);
  }
  return `字幕与格数不匹配：${parts.join("；")}`;
}
