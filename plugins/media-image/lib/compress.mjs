import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolveImageFormat } from "./format.mjs";

// PNG 无损：只加压缩级别，不做 palette 量化（量化伤画质且不可逆）
function encodeOptions(format, quality) {
  switch (format) {
    case "jpeg":
      return { mozjpeg: true, ...(quality === undefined ? {} : { quality }) };
    case "webp":
      return quality === undefined ? {} : { quality };
    case "png":
      return { compressionLevel: 9 };
    default:
      return {};
  }
}

// 单张压缩：不改变分辨率（不 resize），格式保持原样；结果比原图更大时跳过落盘
export async function compressOne(sharp, input, output, { quality }) {
  const format = resolveImageFormat(input);
  const bytesBefore = statSync(input).size;
  const { data, info } = await sharp(input)
    .rotate() // 按 EXIF 方向摆正到像素，避免转码丢方向标签后显示横竖颠倒
    .toFormat(format, encodeOptions(format, quality))
    .toBuffer({ resolveWithObject: true });

  if (data.length >= bytesBefore) {
    return {
      format,
      width: info.width,
      height: info.height,
      bytesBefore,
      bytesAfter: bytesBefore,
      savedBytes: 0,
      savedPercent: 0,
      skipped: true,
    };
  }
  await writeFile(output, data);
  return {
    format,
    width: info.width,
    height: info.height,
    bytesBefore,
    bytesAfter: data.length,
    savedBytes: bytesBefore - data.length,
    savedPercent: Math.round(((bytesBefore - data.length) / bytesBefore) * 1000) / 10,
    skipped: false,
  };
}
