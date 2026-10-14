import { cliError } from "./errors.mjs";

// 视觉模型输出的 cells JSON 解析 + §2 校验（doubao 侧）。
// §2 的字段名冻结：cells[{index,x,y,w,h,text?,fontSize?,align?,position?}] + image{width,height} + source + model?
// 与 media-image/lib/cells-io.mjs 的区别：这里宽容处理模型的常见毛病（归一化坐标、自报尺寸不符、
// 越界几像素），并把每一次宽容写进 notes —— 宽容可以，静默不行。

const ALIGNS = ["left", "center", "right"];
const POSITIONS = ["bottom", "top"];
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 1000;
// 归一化坐标判据（§6.1）：所有 w/h 都 ≤ 1.5 → 模型给的是 0–1 比例而非像素
const NORMALIZED_MAX = 1.5;
const RAW_TRUNCATE = 800;

function providerError(reason, message, details = {}) {
  return cliError("E_PROVIDER_ERROR", message, { reason, ...details });
}

// 剥 ```json … ``` / ``` … ``` 围栏并裁掉首尾闲话（只保留最外层大括号块）
export function stripCodeFences(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return body;
  return body.slice(start, end + 1);
}

// 非抛错形态：handler 需要「解析失败 → 重试一次」，抛错会把重试路径打断
export function parseVisionJson(text) {
  const stripped = stripCodeFences(text);
  try {
    const value = JSON.parse(stripped);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, raw: stripped };
    }
    return { ok: true, value, raw: stripped };
  } catch {
    return { ok: false, raw: stripped };
  }
}

export function unparsableError(raw) {
  return providerError(
    "unparsable_vision_output",
    "视觉模型两次都没有返回可解析的 JSON（可用 --expected 提示格数，或改用 media-grid-caption --cols/--rows 等分）",
    { raw: String(raw ?? "").slice(0, RAW_TRUNCATE) },
  );
}

// 数字容错：模型偶尔把数字写成字符串
function numOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function looksNormalized(cells) {
  return cells.every((c) => {
    const [x, y, w, h] = [numOf(c?.x), numOf(c?.y), numOf(c?.w), numOf(c?.h)];
    return (
      x !== null &&
      y !== null &&
      w !== null &&
      h !== null &&
      x <= NORMALIZED_MAX &&
      y <= NORMALIZED_MAX &&
      w <= NORMALIZED_MAX &&
      h <= NORMALIZED_MAX
    );
  });
}

function readReportedSize(value) {
  const image = value?.image;
  if (!image || typeof image !== "object") return null;
  const width = numOf(image.width);
  const height = numOf(image.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

// 可选字段只做「合法就留、非法就丢」，不因为样式字段脏而整批拒收
function pickStyle(cell) {
  const out = {};
  if (typeof cell?.text === "string" && cell.text.trim() !== "") out.text = cell.text;
  const fontSize = numOf(cell?.fontSize);
  if (
    fontSize !== null &&
    Number.isInteger(fontSize) &&
    fontSize >= FONT_SIZE_MIN &&
    fontSize <= FONT_SIZE_MAX
  ) {
    out.fontSize = fontSize;
  }
  if (typeof cell?.align === "string" && ALIGNS.includes(cell.align.toLowerCase())) {
    out.align = cell.align.toLowerCase();
  }
  if (typeof cell?.position === "string" && POSITIONS.includes(cell.position.toLowerCase())) {
    out.position = cell.position.toLowerCase();
  }
  return out;
}

function isZeroBasedUnique(indexes, count) {
  if (indexes.some((i) => i === null)) return false;
  const set = new Set(indexes);
  return set.size === count && indexes.every((i) => i >= 0 && i < count);
}

// 主入口：把模型返回的对象落成 §2 契约。actual 是本地解出的真实像素尺寸（可能为 null）
export function normalizeVisionCells(value, { actualWidth = null, actualHeight = null } = {}) {
  const list = value?.cells;
  if (!Array.isArray(list) || list.length === 0) {
    throw providerError(
      "invalid_vision_cells",
      "视觉模型没给出任何一格（cells 缺失或为空）：可换 --model 或加 --expected 重试",
      { raw: JSON.stringify(value ?? null).slice(0, RAW_TRUNCATE) },
    );
  }

  const notes = [];
  const reported = readReportedSize(value);
  const width =
    Number.isInteger(actualWidth) && actualWidth > 0 ? actualWidth : (reported?.width ?? null);
  const height =
    Number.isInteger(actualHeight) && actualHeight > 0 ? actualHeight : (reported?.height ?? null);
  if (width === null || height === null) {
    throw providerError(
      "invalid_vision_cells",
      "无法确定画布尺寸：模型未返回 image.width/height 且本地也解不出图片尺寸",
      { reported: value?.image ?? null },
    );
  }
  if (reported && (reported.width !== width || reported.height !== height)) {
    notes.push(
      `模型自报画布 ${Math.round(reported.width)}x${Math.round(reported.height)}，` +
        `与图片真实尺寸 ${width}x${height} 不符，已按比例换算到真实尺寸`,
    );
  }

  // 归一化坐标（0–1）→ 像素：§6.1 明确要求的容错，并写进 notes
  const normalized = list.length > 0 && looksNormalized(list);
  const sx = normalized ? width : width / (reported?.width ?? width);
  const sy = normalized ? height : height / (reported?.height ?? height);
  if (normalized) {
    notes.push(
      `模型返回的是 0–1 归一化坐标，已按图片尺寸 ${width}x${height} 放大为像素（后续坐标均为像素、左上原点）`,
    );
  }

  const tolerance = Math.max(8, Math.round(Math.max(width, height) * 0.01));
  let clamped = 0;
  const cells = [];
  for (let i = 0; i < list.length; i += 1) {
    const src = list[i];
    const x = numOf(src?.x);
    const y = numOf(src?.y);
    const w = numOf(src?.w);
    const h = numOf(src?.h);
    if (x === null || y === null || w === null || h === null) {
      throw providerError(
        "invalid_vision_cells",
        `视觉模型给出的第 ${i} 格缺少/含非法 x,y,w,h（§2 要求四个像素整数）`,
        { cell: i, raw: JSON.stringify(src ?? null).slice(0, 200) },
      );
    }
    let px = Math.round(x * sx);
    let py = Math.round(y * sy);
    let pw = Math.round(w * sx);
    let ph = Math.round(h * sy);
    if (pw <= 0 || ph <= 0) {
      throw providerError(
        "invalid_vision_cells",
        `视觉模型给出的第 ${i} 格宽高非正（w=${pw} h=${ph}）`,
        { cell: i },
      );
    }
    px = Math.max(0, px);
    py = Math.max(0, py);
    // 越界：小幅（≤ tolerance 像素）内收并在 notes 里点名；严重越界直接拒收，绝不静默裁剪
    const overX = px + pw - width;
    const overY = py + ph - height;
    if (overX > tolerance || overY > tolerance) {
      throw providerError(
        "out_of_bounds_cell",
        `视觉模型给出的第 ${i} 格越界超出图像 ${Math.max(overX, 0)}x${Math.max(overY, 0)} 像素` +
          `（容差 ${tolerance}）：可人工修 --output 的 JSON 后再喂 media-grid-caption --cells`,
        { cell: i, x: px, y: py, w: pw, h: ph, image: { width, height }, tolerance },
      );
    }
    if (overX > 0 || overY > 0) clamped += 1;
    if (overX > 0) pw -= overX;
    if (overY > 0) ph -= overY;
    cells.push({ index: i, x: px, y: py, w: pw, h: ph, ...pickStyle(src) });
  }
  if (clamped > 0) {
    notes.push(`有 ${clamped} 格略微越界（≤ ${tolerance} 像素），已内收到画布内`);
  }

  // index 语义是阅读顺序（§2）；模型给的 index 不可信就按返回顺序重编 0..n-1 并说明
  const indexes = list.map((c) => numOf(c?.index));
  if (isZeroBasedUnique(indexes, cells.length)) {
    cells.forEach((cell, i) => {
      cell.index = indexes[i];
    });
  } else {
    notes.push(
      "模型返回的 index 缺失/重复/非 0 起，已按其返回顺序（prompt 要求即阅读顺序）重编号 0..n-1",
    );
  }

  return { cells, image: { width, height }, source: "vision", notes };
}
