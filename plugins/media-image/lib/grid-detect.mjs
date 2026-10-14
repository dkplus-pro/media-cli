// 本地宫格检测（§6.2，只作规则宫格的兜底第二级）。
// 真实分镜页实测结论（2048x2048 的 9 格分镜，S017/S019）：面板带 1–3° 倾斜、相邻格边界互相错开、
// 格宽不等 —— 本算法**必须**判为检测失败并让上层走 fallback-bottom，这是设计好的行为不是 bug。
// 文档里不得宣称本地检测支持不规则宫格。
//
// 算法要点：
// 1. 背景/分隔带取色不再只看四边条带（满幅宫格的四边就是内容，F2）：先出一小撮候选色，
//    再按「该色构成的整行/整列数」打分，覆盖率最高者当选，落选者依次候补。
// 2. 用「整行/整列里背景色的占比」而不是「整行 max-min」找分隔带，
//    这样倾斜描边横穿分隔线时仍能认出分隔带；但认出来之后还要做对齐性校验（§6.2 第 5 条），
//    只要有任一候选格几乎没有内容，就说明行列边界对不上真实格边界 → 整体判失败。
// 3. 每格边长还要过「最小格尺寸」这关：拿内容色当背景时，格间细缝会被当成内容带，
//    产出一堆几条像素大的假格 —— 那种结果必须拒，否则满幅同色内容的宫格会被误检。

import { backgroundCandidates } from "./grid-background.mjs";

// 主入口只做组织与再导出：取色候选在 grid-background.mjs，判定与打分在这里。
export { backgroundCandidates, estimateBackground } from "./grid-background.mjs";

const DEFAULTS = {
  bgTol: 24, // 与背景色允许的最大灰度差
  crossFrac: 0.06, // 允许 6% 的像素横穿分隔线（容忍倾斜描边）
  minGutter: 3, // 分隔带最小厚度（像素）
  edgeBand: 8, // 估背景色用的四边条带宽度
  minContentFrac: 0.35, // 对齐性校验：候选格内非背景像素占比下限
  maxCells: 64, // 超过即判误检
  bgCandidates: 8, // 参与打分的候选背景色个数（不含四边中位数/众数）
  minCellFrac: 0.04, // 每格最小边长 = 短边 × 此比例（且不小于 2×minGutter）
};

export const GRID_DETECT_DEFAULTS = DEFAULTS;

// 逐行/逐列统计「与背景色 |Δ| <= bgTol」的像素占比。**一次**像素遍历算完所有候选色：
// 候选最多 9 个，逐色重扫大图会让 2048x2048 的兜底检测慢上一个数量级。
// coverage[k] = 该色构成的整行数 + 整列数（占比 >= 1-crossFrac），即「像不像分隔带」的分。
function fractionTables(data, width, height, candidates, bgTol, threshold) {
  const n = candidates.length;
  const rows = [];
  const cols = [];
  for (let k = 0; k < n; k += 1) {
    rows.push(new Float64Array(height));
    cols.push(new Float64Array(width));
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const v = data[row + x];
      for (let k = 0; k < n; k += 1) {
        if (Math.abs(v - candidates[k]) <= bgTol) {
          rows[k][y] += 1;
          cols[k][x] += 1;
        }
      }
    }
  }
  const out = [];
  for (let k = 0; k < n; k += 1) {
    let coverage = 0;
    for (let y = 0; y < height; y += 1) {
      rows[k][y] /= width;
      if (rows[k][y] >= threshold) coverage += 1;
    }
    for (let x = 0; x < width; x += 1) {
      cols[k][x] /= height;
      if (cols[k][x] >= threshold) coverage += 1;
    }
    out.push({ bg: candidates[k], rows: rows[k], cols: cols[k], coverage });
  }
  return out;
}

// 占比 >= 1-crossFrac 的连续段即分隔带；厚度 < minGutter 的段丢弃（丢弃后两侧内容带自然合并）。
// 最外圈边框/页面留白同样是分隔带，于是「有边框」与「无边框」两种图统一处理。
// 顺手把最厚的一条分隔带报出去，给上层做「格子必须明显大于分隔带」的合理性校验。
function contentBands(frac, { crossFrac, minGutter }) {
  const length = frac.length;
  const separator = new Uint8Array(length);
  let start = -1;
  let maxSeparator = 0;
  const close = (end) => {
    if (end - start >= minGutter) {
      separator.fill(1, start, end);
      maxSeparator = Math.max(maxSeparator, end - start);
    }
    start = -1;
  };
  for (let i = 0; i < length; i += 1) {
    if (frac[i] >= 1 - crossFrac) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      close(i);
    }
  }
  if (start !== -1) close(length);

  const bands = [];
  let begin = -1;
  for (let i = 0; i < length; i += 1) {
    if (separator[i] === 0) {
      if (begin === -1) begin = i;
    } else if (begin !== -1) {
      bands.push({ start: begin, end: i - 1 });
      begin = -1;
    }
  }
  if (begin !== -1) bands.push({ start: begin, end: length - 1 });
  return { bands, maxSeparator };
}

// 候选格内非背景像素占比（全图各格相加不超过图像面积，不需要积分图）。
// 判据与找分隔带时对称：|灰度 - bg| > bgTol 才算内容 —— 用 "> bg + tol" 会在白底宫格上永远为假
function contentFraction(data, width, cell, bg, bgTol) {
  let hit = 0;
  for (let y = cell.y; y < cell.y + cell.h; y += 1) {
    const row = y * width;
    for (let x = cell.x; x < cell.x + cell.w; x += 1) {
      if (Math.abs(data[row + x] - bg) > bgTol) hit += 1;
    }
  }
  return hit / (cell.w * cell.h);
}

// 选定背景色后的完整判定（§6.2 第 3–7 步，判据一字未改）
function detectWithBackground(data, width, height, cand, opts) {
  const { bg } = cand;
  const row = contentBands(cand.rows, opts);
  const col = contentBands(cand.cols, opts);
  const rowBands = row.bands;
  const colBands = col.bands;

  if (rowBands.length < 1 || colBands.length < 1) return { ok: false, reason: "no_bands" };
  const count = rowBands.length * colBands.length;
  // 单块 = 整图只有一块内容（纯色或无任何分隔线），不是宫格
  if (count === 1) return { ok: false, reason: "single_band" };
  if (count > opts.maxCells) return { ok: false, reason: "too_many_cells" };

  const boxes = [];
  for (let r = 0; r < rowBands.length; r += 1) {
    for (let c = 0; c < colBands.length; c += 1) {
      boxes.push({
        x: colBands[c].start,
        y: rowBands[r].start,
        w: colBands[c].end - colBands[c].start + 1,
        h: rowBands[r].end - rowBands[r].start + 1,
      });
    }
  }

  // 每格至少要有「一眼看上去是一格」的尺寸：拿内容色当背景时，格间细缝会变成仅有的内容带，
  // 那种假格比分隔带本身还窄 —— 三条下限取最大的那条拒掉它
  const minCellSide = Math.max(
    opts.minGutter * 2,
    Math.round(Math.min(width, height) * opts.minCellFrac),
    Math.max(row.maxSeparator, col.maxSeparator),
  );
  for (const box of boxes) {
    if (box.w < minCellSide || box.h < minCellSide) {
      return { ok: false, reason: "cells_too_small" };
    }
  }

  let confidence = 1;
  for (const box of boxes) {
    const frac = contentFraction(data, width, box, bg, opts.bgTol);
    // 行列边界与真实格边界不匹配（倾斜/错位的 irregular 宫格）→ 整体判失败
    if (frac < opts.minContentFrac) return { ok: false, reason: "misaligned_grid" };
    confidence = Math.min(confidence, frac);
  }

  return {
    ok: true,
    // 阅读顺序：先按行（y）再按列（x），index 从 0 连续递增（§2）
    cells: boxes.map((box, index) => ({ index, ...box })),
    confidence: Math.round(confidence * 1000) / 1000,
    background: bg,
  };
}

// 纯函数入口：喂灰度矩阵（1 字节/像素、行优先）→ { ok, cells, confidence } 或 { ok:false, reason }
export function detectGridFromGrey(data, width, height, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "bad_input" };
  }
  if (!data || data.length < width * height) return { ok: false, reason: "bad_input" };

  // 候选顺序：四边条带中位数（§6.2 老口径）→ 四边众数 → 全图高频色，见 grid-background.mjs
  const candidates = backgroundCandidates(data, width, height, {
    edgeBand: opts.edgeBand,
    limit: opts.bgCandidates,
  });
  if (candidates.length === 0) return { ok: false, reason: "no_samples" };

  const scored = fractionTables(
    data,
    width,
    height,
    candidates,
    opts.bgTol,
    1 - opts.crossFrac,
  ).sort((a, b) => b.coverage - a.coverage); // 并列时保持候选原序（四边中位数优先）

  let firstFailure = null;
  for (const cand of scored) {
    const result = detectWithBackground(data, width, height, cand, opts);
    if (result.ok) return result;
    if (firstFailure === null) firstFailure = result;
    // 排序后一条直线都构不出来的候选，往下走只会得到同一个 single_band，不必再试
    if (cand.coverage === 0) break;
  }
  // 全部候选都落选：报打分最高（最像背景）那个的失败原因，保持与老行为一致的可读性
  return firstFailure ?? { ok: false, reason: "no_bands" };
}

// sharp 解码 → 灰度 raw：.rotate() 先摆正 EXIF，raw 的 info 尺寸即最终画布尺寸
export async function detectGrid(sharp, input, options = {}) {
  const { data, info } = await sharp(input)
    .rotate()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const grey = new Uint8Array(data.buffer, data.byteOffset, data.length);
  const result = detectGridFromGrey(grey, info.width, info.height, options);
  return { ...result, width: info.width, height: info.height };
}
