import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { parseBitrate, parseOneOf, runCompressBatch, savedPercent, sumSaved } from "./compress.mjs";
import { cliError } from "./errors.mjs";
import { probeMediaInfo, runFfmpeg } from "./ffmpeg.mjs";
import { resolveFfmpeg, resolveFfprobe } from "./paths.mjs";

const TIMEOUT_MS = 30 * 60 * 1000;
export const AUDIO_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".wav",
  ".aiff",
  ".aif",
];
const AUDIO_FORMATS = ["mp3", "m4a", "aac", "opus", "ogg", "flac"];

// 有损输入保持原格式；wav/aiff/flac 等无损源默认转 flac（无损缩小，不改音质）
const FORMAT_BY_EXT = {
  ".mp3": "mp3",
  ".m4a": "m4a",
  ".aac": "aac",
  ".ogg": "ogg",
  ".oga": "ogg",
  ".opus": "opus",
};

function audioFormatFor(file, formatOption) {
  if (formatOption !== undefined) return formatOption;
  return FORMAT_BY_EXT[path.extname(file).toLowerCase()] ?? "flac";
}

// 各格式的编码参数；flac 无损不受码率影响
function codecArgs(format, bitrate) {
  switch (format) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-b:a", bitrate];
    case "m4a":
    case "aac":
      return ["-c:a", "aac", "-b:a", bitrate];
    case "opus":
      return ["-c:a", "libopus", "-b:a", bitrate];
    case "ogg":
      return ["-c:a", "libvorbis", "-b:a", bitrate];
    default:
      return ["-c:a", "flac", "-compression_level", "8"];
  }
}

async function compressOne(ffmpeg, ffprobe, input, output, opts) {
  const info = await probeMediaInfo(ffprobe, input);
  if (info.hasVideo) {
    throw cliError(
      "E_INVALID_OPTION",
      `输入含视频轨：${input}（压缩视频用 media-compress-video，提取音轨用 media-to-audio）`,
      { option: "--input", value: input },
    );
  }
  const bytesBefore = statSync(input).size;
  await runFfmpeg(ffmpeg, ["-i", input, "-vn", ...codecArgs(opts.format, opts.bitrate), output], {
    timeoutMs: TIMEOUT_MS,
  });
  const bytesAfter = statSync(output).size;
  if (bytesAfter >= bytesBefore) {
    // 已不比原文件更小：回滚输出，报 skipped（与 media-compress 语义一致）
    await rm(output, { force: true });
    return {
      format: opts.format,
      bitrate: opts.format === "flac" ? "lossless" : opts.bitrate,
      durationSec: info.durationSec,
      bytesBefore,
      bytesAfter: bytesBefore,
      savedBytes: 0,
      savedPercent: 0,
      skipped: true,
    };
  }
  const outInfo = await probeMediaInfo(ffprobe, output);
  return {
    format: opts.format,
    bitrate: opts.format === "flac" ? "lossless" : opts.bitrate,
    durationSec: outInfo.durationSec,
    bytesBefore,
    bytesAfter,
    savedBytes: bytesBefore - bytesAfter,
    savedPercent: savedPercent(bytesBefore, bytesAfter),
    skipped: false,
  };
}

export async function compressAudio(ctx, args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  const formatOption = parseOneOf("--format", args.format, AUDIO_FORMATS, undefined);
  const bitrate = parseBitrate("--bitrate", args.bitrate, "128k");
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();

  const data = await runCompressBatch(ctx, args, {
    exts: AUDIO_EXTENSIONS,
    defaultDirName: "min",
    outputExt: (file) => `.${audioFormatFor(file, formatOption)}`,
    one: (input, output) => {
      const format = audioFormatFor(input, formatOption);
      return compressOne(ffmpeg, ffprobe, input, output, { format, bitrate });
    },
  });
  if ("results" in data) {
    return { ...data, ...sumSaved(data.results), bitrate };
  }
  // 单文件以实际处理结果为准（flac 的 bitrate 为 "lossless"）
  return { bitrate, ...data };
}
