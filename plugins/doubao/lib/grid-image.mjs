import { cliError } from "./errors.mjs";

// 送视觉模型前的图片降采样与坐标回算（F1/F2）。
//
// 实测数字（同一张 2048x2048 RGBA 真实分镜页 S019.png，本地编码后量 data URI 长度，未发请求）：
//   原图直送                → data URI 8,737,740 字符
//   长边 1568 + PNG 无损重编码 → 7,935,048 字符（只瘦 9.2% —— 旧注释写的「约 3–4 倍」是错的）
//   长边 1568 + JPEG q82      →   398,300 字符（比原图直送瘦 95.4%）
// 结论：**瘦身靠的是有损重编码，不是降分辨率**。
//
// ⚠️ 瘦身与耗时无关，别把它当稳定性方案：同一页 `--max-side 512`（请求体再瘦 89.5%）与默认 1568
// 一样在 3 次 × 超时上限后仍报 `E_PROVIDER_ERROR / reason:"timeout"`（实测 362.7s）。
// **视觉耗时是 provider 侧的，请求体大小影响不了它** —— 真正的可靠性修复是超时下限
// GRID_LOCATE_TIMEOUT_MS（见 lib/grid-locate.mjs），不是这里的字节数。瘦身只降低传输失败面。
//
// ⚠️ 坐标系是这里唯一容易写错的地方：模型返回的坐标是**缩小后那张图**的像素，
// §2 要求 cells 与 image.width/height 是**原图像素**。所以本模块同时导出
// upscaleCellsToOriginal()，把每个坐标按缩放系数放大回原图空间（含取整溢出的内收）。

export const DEFAULT_MAX_SIDE = 1568;
export const MAX_SIDE_MIN = 256;
export const MAX_SIDE_MAX = 4096;
// 降采样后统一改走 JPEG：宫格边界是「看得清」就够，视觉模型不需要无损格边（实测见文件头）
export const VISION_JPEG_QUALITY = 82;
// 放大回原图后「薄条重叠」的修复阈值：重叠厚度 ÷ 较小格对应边长 ≤ 5% 才敢修。
// 依据：±1 像素在 sx=0.766 下最多造成 ~1.3 原图像素（300px 高的格 = 0.43%）；
// 实测真实页放大后的最坏重叠是 628x24px，厚 24/680 ≈ 3.5%；而模型把两格真框重的实测厚度是 33%。
export const DEFAULT_OVERLAP_LIMIT = 0.05;

const MIME_BY_FORMAT = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// --max-side 走严格校验（与 --expected 同一房子风格）：越界即拒，不静默夹取
export function parseMaxSide(raw) {
  if (raw === undefined) return DEFAULT_MAX_SIDE;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < MAX_SIDE_MIN || n > MAX_SIDE_MAX) {
    throw cliError(
      "E_INVALID_OPTION",
      `--max-side 必须是 ${MAX_SIDE_MIN}-${MAX_SIDE_MAX} 的整数（送视觉模型的图片最长边像素），得到：${raw}`,
      { option: "--max-side", value: String(raw) },
    );
  }
  return n;
}

let sharpPromise;

// sharp 只在这里用来缩图；解不出来就退化为「原图直送」，绝不因为缩图失败打断整条命令
async function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import("sharp").then((m) => m.default ?? m).catch(() => null);
  }
  return sharpPromise;
}

// 文件头解不出尺寸时（少见格式/尾部截断）用 sharp 的 metadata 兜底，不解码全图
export async function readDecodedSize(buffer) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(buffer).metadata();
    if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height)) return null;
    if (meta.width <= 0 || meta.height <= 0) return null;
    return { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

function passthrough(buffer, mime, size, note) {
  return {
    buffer,
    mime,
    width: size?.width ?? null,
    height: size?.height ?? null,
    scale: 1,
    resized: null,
    ...(note ? { note } : {}),
  };
}

// 长边 <= maxSide 或尺寸未知 → 原样送出（scale=1，不改变任何坐标系）。
// 否则 resize(fit:"inside") 保比例缩放，并**统一重编码为 JPEG q82** 送给视觉模型：
// 实测瘦身全靠这一步（文件头：1568 档 PNG 7.94MB → JPEG 0.40MB data URI）。
// alpha 图（真实分镜页常是 RGBA PNG）先压白底 —— provider 侧的图片解码器本来就不收 alpha，
// 由我们显式 flatten 比让它按各自的默认底色瞎猜更可预期；JPEG 编完仍比原图大时按原图直送。
export async function prepareVisionImage(buffer, mime, size, maxSide) {
  const longSide = Math.max(size?.width ?? 0, size?.height ?? 0);
  if (!size || longSide <= maxSide) {
    return passthrough(
      buffer,
      mime,
      size,
      size ? null : "本地解不出图片像素尺寸，已按原图直送（未降采样，请求体偏大易超时）",
    );
  }
  const sharp = await loadSharp();
  if (!sharp) {
    return passthrough(buffer, mime, size, "sharp 不可用，已按原图直送（请求体偏大易超时）");
  }
  let pipeline = sharp(buffer).resize({
    width: maxSide,
    height: maxSide,
    fit: "inside",
    withoutEnlargement: true,
  });
  let note = null;
  try {
    const meta = await sharp(buffer).metadata();
    if (meta.hasAlpha) {
      pipeline = pipeline.flatten({ background: "#ffffff" });
      note = `原图带透明通道（${meta.format}），送模型前已把透明区压成白底并重编码 JPEG`;
    }
  } catch {
    // metadata 读不出就别赌 flatten：alpha 直塞 jpeg 会被 libvips 丢弃通道，
    // 那才是真的「静默改像素」，所以退回无损原格式重编码。
    return passthrough(buffer, mime, size, "读不出图片元数据（是否有透明通道未知），已按原图直送");
  }
  pipeline = pipeline.jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true });
  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    // 缩后反而更大（极少见的病态图）就别白折腾
    if (data.length >= buffer.length) {
      return passthrough(buffer, mime, size, "降采样后体积没有变小，已按原图直送");
    }
    const sentWidth = info.width;
    const sentHeight = info.height;
    return {
      buffer: data,
      mime: MIME_BY_FORMAT[info.format] ?? mime,
      width: sentWidth,
      height: sentHeight,
      // 模型看到的坐标系相对原图的缩放系数（两轴取几何平均后同时上报，实际放大用各自的轴系数）
      scale: round6(Math.sqrt((sentWidth / size.width) * (sentHeight / size.height))),
      resized: {
        maxSide,
        width: sentWidth,
        height: sentHeight,
        sx: round6(sentWidth / size.width),
        sy: round6(sentHeight / size.height),
        bytes: data.length,
        originalBytes: buffer.length,
        // 审计用：送给模型的到底是哪种编码（体积差异的巨大来源，别再让人猜）
        encode: info.format,
        quality: VISION_JPEG_QUALITY,
      },
      ...(note ? { note } : {}),
    };
  } catch (err) {
    return passthrough(
      buffer,
      mime,
      size,
      `降采样失败，已按原图直送（${String(err?.message ?? err).slice(0, 160)}）`,
    );
  }
}

// 把「缩小图坐标系」里的 cells 放大回原图像素（§2 硬要求）。
// 放大后可能因取整溢出 1px，按原图边界内收并在计数里说明 —— 绝不留下越界格让下游直接拒。
export function upscaleCellsToOriginal(cells, sx, sy, original) {
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) {
    return { cells, clamped: 0 };
  }
  if (!Number.isInteger(original?.width) || !Number.isInteger(original?.height)) {
    return { cells, clamped: 0 };
  }
  let clamped = 0;
  const scaled = cells.map((cell) => {
    const out = {
      ...cell,
      x: Math.max(0, Math.round(cell.x / sx)),
      y: Math.max(0, Math.round(cell.y / sy)),
      w: Math.max(1, Math.round(cell.w / sx)),
      h: Math.max(1, Math.round(cell.h / sy)),
    };
    const overX = out.x + out.w - original.width;
    const overY = out.y + out.h - original.height;
    if (overX > 0 || overY > 0) clamped += 1;
    if (overX > 0) out.w -= overX;
    if (overY > 0) out.h -= overY;
    return out;
  });
  return { cells: scaled, clamped };
}
