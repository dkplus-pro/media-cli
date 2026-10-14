// 黑条的几何与 SVG（§6.2 正常版式的「画什么」部分，从 grid-caption.mjs 拆出以便两个文件都留在校量之下）。
// grid-caption.mjs 负责「算与写盘」，这里只负责「一格 → 一条 rect + N 行 text」的纯构造。
// ⚠️ 不变量：黑条永远 clamp 在所属格内（绝不跨到邻格）；用户文本一律过 escapeXml；
// viewBox 与 width/height 同值 —— librsvg 必须按 1:1 光栅化，否则像素坐标会漂移。

import { escapeXml } from "./watermark.mjs";

const BAR_LINE_FACTOR = 1.35; // 行高 = fontSize × 1.35（§6.2）
const BASELINE_FACTOR = 0.8; // SVG 基线经验值：slot 顶部 + 0.8×字号，视觉上正好居中
function round2(n) {
  return Math.round(n * 100) / 100;
}

// 每格一条黑条：条宽=格宽，条高=行数×行高+2×padding，clamp 到格内（绝不跨到邻格）
export function barForCell(cell, plan, { position, padding, align }) {
  const height = Math.max(1, Math.min(Math.ceil(plan.barHeight), cell.h));
  const y = position === "top" ? cell.y : cell.y + cell.h - height;
  return {
    // index 只为 data.fontSizePerCell 的归属清楚；绘制本身用不到
    index: cell.index,
    x: cell.x,
    y,
    width: cell.w,
    height,
    lines: plan.lines,
    fontSize: plan.fontSize,
    lineHeight: round2(plan.fontSize * BAR_LINE_FACTOR),
    padding,
    align: align ?? "center",
  };
}

function anchorOf(bar) {
  if (bar.align === "left") return { x: round2(bar.x + bar.padding), name: "start" };
  if (bar.align === "right") return { x: round2(bar.x + bar.width - bar.padding), name: "end" };
  return { x: round2(bar.x + bar.width / 2), name: "middle" };
}

// 一格 = 一个 rect + 每行一个 text（用户文本必须过 escapeXml，颜色只可能是 COLOR_RE 放行后的值）
export function buildBarNodes(bar, { textColor, font, opacity }) {
  const { x, name } = anchorOf(bar);
  const rect =
    `<rect x="${bar.x}" y="${round2(bar.y)}" width="${bar.width}" height="${bar.height}"` +
    ` fill="#000000" fill-opacity="${opacity}"/>`;
  const texts = bar.lines
    .map((line, i) => {
      const baseline = round2(
        bar.y + bar.padding + i * bar.lineHeight + bar.fontSize * BASELINE_FACTOR,
      );
      return (
        `<text x="${x}" y="${baseline}" font-family="${escapeXml(font)}" font-size="${bar.fontSize}"` +
        ` fill="${textColor}" text-anchor="${name}">${escapeXml(line)}</text>`
      );
    })
    .join("");
  return rect + texts;
}

// 一张满画布 SVG 装下所有黑条，sharp 只做一次 composite（尺寸必须 ≤ 底图，否则 sharp 直接报错）
export function buildCaptionSvg({ width, height, bars, font, textColor, opacity }) {
  const nodes = bars.map((bar) => buildBarNodes(bar, { textColor, font, opacity })).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${nodes}</svg>`;
}
