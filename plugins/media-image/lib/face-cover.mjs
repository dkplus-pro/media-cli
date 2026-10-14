import { writeFile } from "node:fs/promises";
import { detectFaces } from "./detect-faces.mjs";
import { cliError } from "./errors.mjs";
import { resolveImageFormat } from "./format.mjs";

const SCALE_MIN = 0.5;
const SCALE_MAX = 3.0;

function invalid(option, expected, raw) {
  return cliError("E_INVALID_OPTION", `${option} ${expected}，得到：${raw}`, {
    option,
    value: String(raw),
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 内切圆放大倍数：0.5–3.0（默认 1.2 是为盖住发际线与下巴，Vision 的框偏紧）
export function parseScale(raw, fallback = 1.2) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < SCALE_MIN || n > SCALE_MAX) {
    throw invalid("--scale", `必须是 ${SCALE_MIN}-${SCALE_MAX} 的数字`, raw);
  }
  return n;
}

export function parseMinConfidence(raw, fallback = 0.3) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw invalid("--min-confidence", "必须是 0-1 的小数，如 0.6", raw);
  }
  return n;
}

// --at x,y,r（像素、左上原点）可重复：commander 变参把每次出现累加成数组
export function parseAtList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const circles = [];
  for (const item of list) {
    const parts = String(item)
      .split(",")
      .map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => part === "")) {
      throw invalid("--at", "必须是 x,y,r 三个像素值（如 --at 100,100,40）", item);
    }
    const [x, y, r] = parts.map(Number);
    if (![x, y, r].every((n) => Number.isFinite(n))) {
      throw invalid("--at", "x,y,r 都必须是数字", item);
    }
    if (r <= 0) throw invalid("--at", "半径 r 必须大于 0", item);
    circles.push({ x, y, r, confidence: null, source: "manual" });
  }
  return circles;
}

// 人脸框 → 圆：内切圆 × scale，圆心 = 框中心
export function circleForFace(face, scale) {
  return {
    cx: face.x + face.w / 2,
    cy: face.y + face.h / 2,
    r: (Math.min(face.w, face.h) / 2) * scale,
    confidence: face.confidence,
    source: "vision",
  };
}

// 低置信度（默认 < 0.3）与退化框（w/h <= 0）不遮
export function facesToCircles(faces, { scale, minConfidence }) {
  return faces
    .filter((face) => face.w > 0 && face.h > 0 && face.confidence >= minConfidence)
    .map((face) => circleForFace(face, scale));
}

// 圆心 clamp 进画布：圆超出画布不裁剪（SVG 自动裁），但圆心必须落在画面内，
// 否则检出的框整体偏移时白圆会一整个跑到图外（等于没遮）
export function clampCircle(circle, width, height) {
  return {
    ...circle,
    cx: Math.min(Math.max(circle.cx, 0), width),
    cy: Math.min(Math.max(circle.cy, 0), height),
  };
}

// 一张覆盖全画布的 SVG 装下所有 <circle>，sharp 只做一次 composite
export function buildCircleSvg({ width, height, circles, color }) {
  const nodes = circles
    .map(
      (c) =>
        `<circle cx="${round2(c.cx)}" cy="${round2(c.cy)}" r="${round2(c.r)}" fill="${color}"/>`,
    )
    .join("");
  // viewBox 与 width/height 同值：librsvg 必须按 1:1 光栅化，否则像素坐标会漂移
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${nodes}</svg>`;
}

// .rotate() 后的真实画布尺寸：EXIF orientation 5-8 会交换宽高（零解码，只读 metadata）。
// 必须与 Swift 侧 applyOrientationProperty 的坐标系一致，且 SVG 尺寸不得大于底图
// （sharp 对更大的 overlay 直接报 "must have same dimensions or smaller"）。
export async function canvasSize(sharp, input) {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) {
    throw cliError("E_PROVIDER_ERROR", `无法读取图片尺寸：${input}`, { source: "sharp", input });
  }
  const swap = (meta.orientation ?? 1) >= 5 && (meta.orientation ?? 1) <= 8;
  return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
}

// Vision 的 extent 与 libvips 摆正后的画布理论上相同；万一有 1px 级偏差就按比例映射，
// 既保住坐标语义，也避免 overlay 比底图大导致整条命令失败
function rescaleFaces(vision, canvas) {
  const sx = canvas.width / vision.width;
  const sy = canvas.height / vision.height;
  if (sx === 1 && sy === 1) return vision.faces;
  return vision.faces.map((face) => ({
    ...face,
    x: face.x * sx,
    y: face.y * sy,
    w: face.w * sx,
    h: face.h * sy,
  }));
}

// 遮脸重编码沿用 media-compress 的档位（jpeg/webp quality 80，png 无损）
function encodeOptions(format) {
  switch (format) {
    case "jpeg":
      return { mozjpeg: true, quality: 80 };
    case "webp":
      return { quality: 80 };
    default:
      return { compressionLevel: 9 };
  }
}

// 工厂：runBatch 的 processOne —— 每张图片「检测 → 合并人工圆 → 一次合成 → 落盘」
export function createFaceCoverer({ sharp, ctx, bin, scale, minConfidence, manual, color }) {
  return async function coverOne(file, output) {
    const canvas = await canvasSize(sharp, file);
    let faces = [];
    if (bin) {
      try {
        faces = rescaleFaces(await detectFaces(bin, file), canvas);
      } catch (err) {
        // 传了 --at 就降级：人工坐标不需要检测器（与 media-av 的 drawtext 降级先例一致）
        if (manual.length === 0) throw err;
        ctx.warnings.add({
          code: typeof err?.code === "string" ? err.code : "E_PROVIDER_ERROR",
          message: `人脸检测不可用，仅按 --at 人工圆遮脸：${err?.message ?? err}`,
          plugin: "media-image",
        });
      }
    }

    const circles = [
      ...facesToCircles(faces, { scale, minConfidence }),
      ...manual.map((c) => ({ cx: c.x, cy: c.y, r: c.r, confidence: null, source: "manual" })),
    ].map((c) => clampCircle(c, canvas.width, canvas.height));

    if (circles.length === 0) {
      ctx.warnings.add({
        code: "E_NO_FACE_DETECTED",
        message: `未检出人脸（${file}）：已输出原图副本，可用 --at x,y,r 人工遮脸`,
        plugin: "media-image",
      });
    }

    const format = resolveImageFormat(file);
    const pipeline = sharp(file).rotate();
    // rotate 先于 composite（sharp 固定管线顺序）：JS 侧也摆正 EXIF，与 Swift 坐标系对齐
    if (circles.length > 0) {
      pipeline.composite([
        { input: Buffer.from(buildCircleSvg({ ...canvas, circles, color })), left: 0, top: 0 },
      ]);
    }
    const { data, info } = await pipeline
      .toFormat(format, encodeOptions(format))
      .toBuffer({ resolveWithObject: true });
    await writeFile(output, data);

    ctx.logger.debug(`人脸遮罩 ${circles.length} 个圆 → ${output}`);
    return {
      bytes: info.size,
      width: info.width,
      height: info.height,
      covered: circles.length,
      faces: circles.map((c) => ({
        x: round2(c.cx),
        y: round2(c.cy),
        r: round2(c.r),
        confidence: c.confidence,
        source: c.source,
      })),
    };
  };
}
