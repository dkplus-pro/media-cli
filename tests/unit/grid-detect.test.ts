import { describe, expect, it } from "vitest";
import {
  backgroundCandidates,
  detectGridFromGrey,
  estimateBackground,
} from "../../plugins/media-image/lib/grid-detect.mjs";

// §6.2 的本地检测是「纯函数喂灰度矩阵」就能全覆盖的算法，所以单测直接手工造矩阵，
// 不依赖 sharp 解码（sharp 路径由 e2e 的 2x2 规则宫格 fixture 负责）。

interface Grey {
  data: Uint8Array;
  w: number;
  h: number;
}

// 规则宫格：外圈 + 格间都是 background 色带，格内填内容灰度
function gridMatrix(
  cols: number,
  rows: number,
  cell: number,
  gutter: number,
  shade = 30,
  background = 255,
): Grey {
  const w = gutter + cols * (cell + gutter);
  const h = gutter + rows * (cell + gutter);
  const data = new Uint8Array(w * h).fill(background);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const top = gutter + r * (cell + gutter);
      const left = gutter + c * (cell + gutter);
      for (let y = top; y < top + cell; y += 1) {
        for (let x = left; x < left + cell; x += 1) data[y * w + x] = shade;
      }
    }
  }
  return { data, w, h };
}

// 整页旋转（真实分镜页的形态：面板带 1–3° 倾斜、边界互相错开）
function rotateMatrix({ data, w, h }: Grey, deg: number): Grey {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.round(cx + (x - cx) * cos + (y - cy) * sin);
      const sy = Math.round(cy - (x - cx) * sin + (y - cy) * cos);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = data[sy * w + sx];
    }
  }
  return { data: out, w, h };
}

// 满幅宫格（F2）：内容一直顶到图片边缘，只有格间的细缝是分隔带，**没有任何外边距**。
// 这种图的老算法必然栽：四边 8px 条带取到的是内容色，于是所有块都被当成背景 → single_band。
function fullBleedMatrix(
  cols: number,
  rows: number,
  gutter: number,
  shades: number[] | ((index: number) => number),
  cell = 48,
): Grey {
  const side = cell * Math.max(cols, rows) + gutter * (Math.max(cols, rows) - 1);
  const w = Math.round(side / cols) * cols;
  const h = Math.round(side / rows) * rows;
  const cellW = Math.floor(w / cols);
  const cellH = Math.floor(h / rows);
  const data = new Uint8Array(w * h).fill(255);
  const shadeOf = typeof shades === "function" ? shades : (i: number) => shades[i % shades.length];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = shadeOf(r * cols + c);
      const left = c * cellW + (c === 0 ? 0 : Math.ceil(gutter / 2));
      const right = (c + 1) * cellW - (c === cols - 1 ? 0 : Math.floor(gutter / 2));
      const top = r * cellH + (r === 0 ? 0 : Math.ceil(gutter / 2));
      const bottom = (r + 1) * cellH - (r === rows - 1 ? 0 : Math.floor(gutter / 2));
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) data[y * w + x] = v;
      }
    }
  }
  return { data, w, h };
}

function diagonalGradient(n: number): Grey {
  const data = new Uint8Array(n * n);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) data[y * n + x] = Math.round(((x + y) / (2 * (n - 1))) * 255);
  }
  return { data, w: n, h: n };
}

const detect = (grey: Grey, options: Record<string, unknown> = {}) =>
  detectGridFromGrey(grey.data, grey.w, grey.h, { edgeBand: 4, ...options });

describe("media-grid-caption 本地宫格检测", () => {
  it("estimateBackground 取四边条带中位数（白底 255 / 黑底 0）", () => {
    const white = gridMatrix(2, 2, 20, 6, 30, 255);
    const black = gridMatrix(2, 2, 20, 6, 200, 0);
    expect(estimateBackground(white.data, white.w, white.h, 4)).toBe(255);
    expect(estimateBackground(black.data, black.w, black.h, 4)).toBe(0);
  });

  it("2x2 白带宫格 → 4 格且坐标精确到分隔带内侧", () => {
    const result = detect(gridMatrix(2, 2, 40, 8));
    expect(result.ok).toBe(true);
    expect(result.cells).toEqual([
      { index: 0, x: 8, y: 8, w: 40, h: 40 },
      { index: 1, x: 56, y: 8, w: 40, h: 40 },
      { index: 2, x: 8, y: 56, w: 40, h: 40 },
      { index: 3, x: 56, y: 56, w: 40, h: 40 },
    ]);
    expect(result.confidence).toBe(1);
  });

  it("3x3 → 9 格，index 按阅读顺序（先 y 后 x），中心格是 4", () => {
    const result = detect(gridMatrix(3, 3, 80, 8));
    expect(result.cells).toHaveLength(9);
    expect(result.cells.map((c: { index: number }) => c.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(result.cells[4]).toEqual({ index: 4, x: 96, y: 96, w: 80, h: 80 });
    expect(result.cells[8]).toEqual({ index: 8, x: 184, y: 184, w: 80, h: 80 });
  });

  it("黑底白格的反色宫格同样能检（背景取自边缘，不假设宫格底是白）", () => {
    const result = detect(gridMatrix(2, 2, 30, 6, 220, 10));
    expect(result.ok).toBe(true);
    expect(result.cells).toHaveLength(4);
  });

  it("不等宽但分隔线对齐的两列 → 2 格且 w 不等（规则宫格不要求等宽）", () => {
    const gutter = 8;
    const widths = [30, 52];
    const height = 40;
    const w = gutter + widths[0] + gutter + widths[1] + gutter;
    const data = new Uint8Array(w * (height + 2 * gutter)).fill(255);
    let left = gutter;
    for (const width of widths) {
      for (let y = gutter; y < gutter + height; y += 1) {
        for (let x = left; x < left + width; x += 1) data[y * w + x] = 40;
      }
      left += width + gutter;
    }
    const result = detect({ data, w, h: height + 2 * gutter });
    expect(result.cells.map((c: { x: number; w: number }) => [c.x, c.w])).toEqual([
      [8, 30],
      [46, 52],
    ]);
  });

  it("纯色整图 → 判失败（没有任何内容带）", () => {
    const flat = { data: new Uint8Array(64 * 64).fill(255), w: 64, h: 64 };
    expect(detect(flat)).toMatchObject({ ok: false, reason: "no_bands" });
  });

  it("对角渐变（无任何分隔线）→ 判失败", () => {
    const grey = diagonalGradient(128);
    expect(detect(grey).ok).toBe(false);
    expect(detect(grey)).toMatchObject({ reason: "single_band" });
  });

  it("整页倾斜 ≥2° 的不规则宫格 → 明确判失败，交由上层走 fallback-bottom", () => {
    // 实测边界：同一张 3x3 合成宫格 0°/1° 仍可检出，2° 起分隔带被倾斜描边横穿而整体失效。
    // 真实分镜页（2048x2048 的 S017/S019，面板带 1–3° 倾斜）本地检测同样返回 single_band。
    expect(detect(rotateMatrix(gridMatrix(3, 3, 80, 8), 1)).cells).toHaveLength(9);
    expect(detect(rotateMatrix(gridMatrix(3, 3, 80, 8), 2))).toMatchObject({
      ok: false,
      reason: "single_band",
    });
    expect(detect(rotateMatrix(gridMatrix(3, 3, 80, 8), 5)).ok).toBe(false);
  });

  it("对齐性校验：行列边界与真实格边界不匹配（有空象限）→ misaligned_grid", () => {
    const gutter = 8;
    const cell = 36;
    const w = gutter * 3 + cell * 2;
    const data = new Uint8Array(w * w).fill(255);
    const put = (r: number, c: number) => {
      for (let y = gutter + r * (cell + gutter); y < gutter + r * (cell + gutter) + cell; y += 1) {
        for (
          let x = gutter + c * (cell + gutter);
          x < gutter + c * (cell + gutter) + cell;
          x += 1
        ) {
          data[y * w + x] = 20;
        }
      }
    };
    put(0, 0);
    put(1, 1); // 另两个象限空着 → 笛卡尔积里有候选格几乎没有内容
    expect(detect({ data, w, h: w })).toMatchObject({ ok: false, reason: "misaligned_grid" });
  });

  it("格数超过 64 视为误检", () => {
    expect(detect(gridMatrix(9, 9, 10, 4))).toMatchObject({ ok: false, reason: "too_many_cells" });
  });

  it("minGutter 太厚会把细分隔带丢掉（合并成更少的大格）", () => {
    const thin = detect(gridMatrix(2, 2, 40, 3));
    expect(thin.cells).toHaveLength(4);
    expect(detect(gridMatrix(2, 2, 40, 3), { minGutter: 4 })).toMatchObject({
      ok: false,
      reason: "single_band",
    });
  });

  it("满幅 2x2（内容顶到边缘、无外边距）→ 检出 4 格（F2 的主案发现场）", () => {
    // 老算法在这张图上取到的「背景」是某个内容色，于是每块都被当成背景 → single_band
    const full = fullBleedMatrix(2, 2, 8, [40, 90, 140, 200]);
    expect(estimateBackground(full.data, full.w, full.h, 4)).not.toBe(255);
    const result = detect(full);
    expect(result.ok).toBe(true);
    expect(result.background).toBe(255); // 认出来的其实是格间细缝的颜色，不是边框颜色
    expect(result.cells).toHaveLength(4);
    expect(result.cells[0]).toMatchObject({ index: 0, x: 0, y: 0 });
    expect(result.cells[3].x + result.cells[3].w).toBeLessThanOrEqual(full.w);
    expect(result.cells[3].y + result.cells[3].h).toBeLessThanOrEqual(full.h);
  });

  it("满幅 3x3 且九格同色 → 靠「格子必须比分隔带大」把内容色选出的假格拒掉", () => {
    // 只限制候选色数（等于退回老算法的单色取色）时报 cells_too_small；放开候选后必须检出 9 格
    const full = fullBleedMatrix(3, 3, 6, () => 30, 100);
    expect(detect(full, { bgCandidates: 1, edgeBand: 1 })).toMatchObject({
      ok: false,
      reason: "cells_too_small",
    });
    const result = detect(full);
    expect(result.ok).toBe(true);
    expect(result.background).toBe(255);
    expect(result.cells).toHaveLength(9);
  });

  it("满幅 4x3（横竖缝都只有细缝，四边全是内容）→ 12 格", () => {
    const result = detect(
      fullBleedMatrix(4, 3, 10, [15, 45, 75, 105, 135, 165, 195, 215, 25, 55, 85, 115]),
    );
    expect(result.ok).toBe(true);
    expect(result.cells).toHaveLength(12);
    expect(result.cells.map((c: { index: number }) => c.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it("backgroundCandidates：四边中位数排第一，分隔带色必在候选里", () => {
    const full = fullBleedMatrix(2, 2, 8, [40, 90, 140, 200]);
    const candidates = backgroundCandidates(full.data, full.w, full.h, {
      edgeBand: 4,
      limit: 8,
    });
    expect(candidates[0]).toBe(estimateBackground(full.data, full.w, full.h, 4));
    expect(candidates).toContain(255);
    // 纯色图只剩一个候选色，打分也无从区分
    expect(backgroundCandidates(new Uint8Array(16).fill(7), 4, 4)).toEqual([7]);
  });

  it("满幅图放大 --flat-tol 也救不回老取色（说明错在选色不是容差）", () => {
    const full = fullBleedMatrix(2, 2, 8, [40, 90, 140, 200]);
    // 单候选色 = 四边中位数（内容色）时，无论容差多大都判不出宫格
    for (const bgTol of [24, 60, 120]) {
      expect(detect(full, { bgCandidates: 1, edgeBand: 1, bgTol })).toMatchObject({
        ok: false,
      });
    }
    expect(detect(full).ok).toBe(true);
  });

  it("非法输入（尺寸与数据不符）→ bad_input", () => {
    expect(detectGridFromGrey(new Uint8Array(4), 10, 10)).toMatchObject({
      ok: false,
      reason: "bad_input",
    });
    expect(detectGridFromGrey(new Uint8Array(100), 0, 10)).toMatchObject({
      ok: false,
      reason: "bad_input",
    });
  });
});
