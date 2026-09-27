import { writeFile } from "node:fs/promises";
import { cliError } from "./errors.mjs";
import { resolveImageFormat } from "./format.mjs";

const GRID_NODE_LIMIT = 20000;

export function escapeXml(text) {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

// 自动字号：图片最短边 1/24，限制在 14–160
export function autoFontSize(width, height) {
  return Math.min(160, Math.max(14, Math.round(Math.min(width, height) / 24)));
}

// 用与正式渲染相同的管线实测文字包围盒（librsvg 的字体回退行为一致，测量即所见）
export async function measureText(sharp, { text, font, fontSize, color, opacity }) {
  const pad = Math.ceil(fontSize);
  const width = Math.ceil(text.length * fontSize * 1.5) + pad * 2;
  const height = Math.ceil(fontSize * 3);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<text x="${pad}" y="${pad + fontSize}" font-family="${escapeXml(font)}" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}">${escapeXml(text)}</text></svg>`;
  const { info } = await sharp(Buffer.from(svg)).trim().png().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) {
    throw cliError("E_PROVIDER_ERROR", "水印文字渲染结果为空（字体不可用？）", {
      source: "sharp",
      text,
    });
  }
  return { width: info.width, height: info.height };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 斜角平铺 SVG：在旋转坐标系里等距布点，形成经典的对角水印行；超界文字由 SVG 视口裁掉
export function buildOverlaySvg({
  width,
  height,
  text,
  font,
  fontSize,
  color,
  opacity,
  angle,
  spacing,
  textW,
  textH,
}) {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // 整图在旋转坐标系两轴上的投影长度，网格以此为中心铺满
  const extentU = Math.abs(width * cos) + Math.abs(height * sin);
  const extentV = Math.abs(width * sin) + Math.abs(height * cos);
  const stepX = Math.max(1, textW + spacing);
  const stepY = Math.max(1, textH + spacing);
  const cols = Math.ceil(extentU / stepX) + 1;
  const rows = Math.ceil(extentV / stepY) + 1;
  if (cols * rows > GRID_NODE_LIMIT) {
    throw cliError(
      "E_INVALID_OPTION",
      `水印数量过多（${cols}×${rows}，上限 ${GRID_NODE_LIMIT}）：请增大 --spacing 或 --font-size`,
      { option: "--spacing", cols, rows },
    );
  }
  const halfC = (cols - 1) / 2;
  const halfR = (rows - 1) / 2;
  const cx = width / 2;
  const cy = height / 2;
  const parts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const du = (c - halfC) * stepX;
      const dv = (r - halfR) * stepY;
      const x = round2(cx + du * cos - dv * sin);
      const y = round2(cy + du * sin + dv * cos);
      // 文字以格点为中心：先平移再旋转，锚点取包围盒左上角的对称位置
      parts.push(
        `<text transform="translate(${x} ${y}) rotate(${angle})" x="${-textW / 2}" y="${round2(textH / 2)}" font-family="${escapeXml(font)}" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}">${escapeXml(text)}</text>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

function encode(pipeline, format) {
  // 水印重编码用高画质：jpeg/webp 92/90，png 无损
  switch (format) {
    case "jpeg":
      return pipeline.jpeg({ quality: 92, mozjpeg: true });
    case "webp":
      return pipeline.webp({ quality: 90 });
    default:
      return pipeline.png({ compressionLevel: 9 });
  }
}

// 工厂：同一批图片共享文字测量缓存（字号相同时只测一次）
export function createWatermarker(sharp, opts) {
  let cachedKey = null;
  let cachedBox = null;
  return async function apply(file, output) {
    const format = resolveImageFormat(file);
    const meta = await sharp(file).metadata();
    if (!meta.width || !meta.height) {
      throw cliError("E_PROVIDER_ERROR", `无法读取图片尺寸：${file}`, { source: "sharp", file });
    }
    const fontSize = opts.fontSize ?? autoFontSize(meta.width, meta.height);
    const key = String(fontSize);
    if (cachedKey !== key) {
      cachedBox = await measureText(sharp, { ...opts, fontSize });
      cachedKey = key;
    }
    const overlay = buildOverlaySvg({
      width: meta.width,
      height: meta.height,
      text: opts.text,
      font: opts.font,
      fontSize,
      color: opts.color,
      opacity: opts.opacity,
      angle: opts.angle,
      spacing: opts.spacing,
      textW: cachedBox.width,
      textH: cachedBox.height,
    });
    // rotate 先于 composite（sharp 固定管线顺序）：先把 EXIF 方向落到像素，再叠水印
    const { data, info } = await encode(
      sharp(file)
        .rotate()
        .composite([{ input: Buffer.from(overlay), left: 0, top: 0 }]),
      format,
    ).toBuffer({ resolveWithObject: true });
    await writeFile(output, data);
    return { format, width: info.width, height: info.height, fontSize };
  };
}
