import { stat } from "node:fs/promises";
import path from "node:path";
import { cliError } from "./errors.mjs";

// doubao-grid-locate 的入参解析与本地读图（从 grid-locate.mjs 拆出来：
// AGENTS.md §6 的 300 行红线，handler 只留「编排」，这里全是「怎么把命令行落成值」）。

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// --timeout 的取值范围（默认值住在 config.mjs：GRID_LOCATE_TIMEOUT_MS）
export const GRID_TIMEOUT_MIN_MS = 1_000;
export const GRID_TIMEOUT_MAX_MS = 1_800_000;

export function requireString(value, option) {
  if (typeof value !== "string" || value.trim() === "") {
    throw cliError("E_MISSING_ARGUMENT", `缺少必填 ${option}`, { option });
  }
  return value.trim();
}

// --expected 只做「提示模型」用（真正的数量校验在 --output 之后，见 grid-locate.mjs）
export function parseExpected(raw) {
  if (raw === undefined) return null;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    throw cliError("E_INVALID_OPTION", `--expected 必须是 1-64 的整数，得到：${raw}`, {
      option: "--expected",
      value: String(raw),
    });
  }
  return n;
}

// --timeout：覆盖本命令的超时下限（毫秒，与 DOUBAO_TIMEOUT_MS 同一单位，免得两头换算）。
// 与 --max-side 同风格：越界即拒，不静默夹取。
export function parseTimeoutMs(raw) {
  if (raw === undefined) return null;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n) || n < GRID_TIMEOUT_MIN_MS || n > GRID_TIMEOUT_MAX_MS) {
    throw cliError(
      "E_INVALID_OPTION",
      `--timeout 必须是 ${GRID_TIMEOUT_MIN_MS}-${GRID_TIMEOUT_MAX_MS} 的整数（毫秒；实测单页 181–330s，别设到 180000 以下），得到：${raw}`,
      { option: "--timeout", value: String(raw) },
    );
  }
  return n;
}

export function mimeOf(file) {
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mime) {
    throw cliError(
      "E_INVALID_OPTION",
      `不支持的图片类型：${file}（仅 ${Object.keys(MIME_BY_EXT).join("/")}）`,
      { option: "--input", value: file },
    );
  }
  return mime;
}

// 本地解像素尺寸（PNG IHDR / JPEG SOF / WebP VP8|VP8L|VP8X）：
// 不做解码、不引 sharp —— 尺寸只用来给 prompt 提供真值、把模型的归一化/自报尺寸偏差校正回来。
// 解不出返回 null，交给模型自报的 image.width/height 兜底。
export function readImageSize(buffer) {
  if (!buffer || buffer.length < 30) return null;
  // PNG: 8 字节签名 + 4 字节长度 + "IHDR" + width(4) height(4)
  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // WebP: RIFF....WEBP + 子块
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const fourcc = buffer.toString("ascii", 12, 16);
    if (fourcc === "VP8X") {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (fourcc === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8 ") {
      const start = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
      if (start !== -1 && start + 6 < buffer.length) {
        return {
          width: buffer.readUInt16LE(start + 3) & 0x3fff,
          height: buffer.readUInt16LE(start + 5) & 0x3fff,
        };
      }
      return null;
    }
    return null;
  }
  // JPEG: 逐个 marker 走到第一个 SOF（含尺寸），跳过注释与 APP 段的填充 0xFF
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset];
      offset += 1;
      if (marker === undefined || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      const size = buffer.readUInt16BE(offset);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      }
      offset += size;
    }
  }
  return null;
}

// 本命令只做单图（宫格与字幕一一对应，目录语义不清）
export async function resolveSingleFile(input) {
  if (!input) throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  const info = await stat(input).catch(() => null);
  if (!info) {
    throw cliError("E_MISSING_ARGUMENT", `输入不存在：${input}`, {
      option: "--input",
      value: input,
    });
  }
  if (info.isDirectory()) {
    throw cliError("E_INVALID_OPTION", `--input 只接受单张图片，不接受目录：${input}`, {
      option: "--input",
      value: input,
    });
  }
  if (!info.isFile()) {
    throw cliError("E_INVALID_OPTION", `--input 既不是文件也不是目录：${input}`, {
      option: "--input",
      value: input,
    });
  }
  return input;
}
