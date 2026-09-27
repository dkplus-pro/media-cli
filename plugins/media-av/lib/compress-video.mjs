import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  parseBitrate,
  parseIntIn,
  parseOneOf,
  runCompressBatch,
  savedPercent,
  sumSaved,
} from "./compress.mjs";
import { cliError } from "./errors.mjs";
import { probeMediaInfo, runFfmpeg } from "./ffmpeg.mjs";
import { resolveFfmpeg, resolveFfprobe } from "./paths.mjs";

const TIMEOUT_MS = 60 * 60 * 1000; // 视频重编码可能很慢，放宽到 1 小时
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".flv", ".wmv"];
const VIDEO_FORMATS = ["mp4", "mov", "mkv"];
const X264_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
];

async function compressOne(ffmpeg, ffprobe, input, output, opts) {
  const info = await probeMediaInfo(ffprobe, input);
  if (!info.hasVideo) {
    throw cliError(
      "E_INVALID_OPTION",
      `输入不含视频轨：${input}（音频压缩用 media-compress-audio）`,
      {
        option: "--input",
        value: input,
      },
    );
  }
  const bytesBefore = statSync(input).size;
  await runFfmpeg(
    ffmpeg,
    [
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?", // 无音轨的视频也能过（可选映射）
      "-c:v",
      opts.codec === "hevc" ? "libx265" : "libx264",
      "-crf",
      String(opts.crf),
      "-preset",
      opts.preset,
      ...(opts.maxHeight === null ? [] : ["-vf", `scale=-2:'min(ih,${opts.maxHeight})'`]),
      "-pix_fmt",
      "yuv420p", // 最大化播放器兼容性
      ...(opts.format === "mp4" ? ["-movflags", "+faststart"] : []),
      ...(opts.codec === "hevc" && opts.format !== "mkv" ? ["-tag:v", "hvc1"] : []), // Apple 生态可播
      "-c:a",
      "aac",
      "-b:a",
      opts.audioBitrate,
      output,
    ],
    { timeoutMs: TIMEOUT_MS },
  );
  const bytesAfter = statSync(output).size;
  if (bytesAfter >= bytesBefore) {
    // 已不比原图更小：回滚输出，报 skipped（与 media-compress 语义一致）
    await rm(output, { force: true });
    return {
      format: opts.format,
      codec: opts.codec,
      width: info.width,
      height: info.height,
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
    codec: opts.codec,
    width: outInfo.width,
    height: outInfo.height,
    durationSec: outInfo.durationSec,
    bytesBefore,
    bytesAfter,
    savedBytes: bytesBefore - bytesAfter,
    savedPercent: savedPercent(bytesBefore, bytesAfter),
    skipped: false,
  };
}

export async function compressVideo(ctx, args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  const crf = parseIntIn("--crf", args.crf, 0, 51, 26);
  const preset = parseOneOf("--preset", args.preset, X264_PRESETS, "medium");
  const codec = parseOneOf("--codec", args.codec, ["h264", "hevc"], "h264");
  const format = parseOneOf("--format", args.format, VIDEO_FORMATS, "mp4");
  const maxHeight =
    args.maxHeight === undefined
      ? null
      : parseIntIn("--max-height", args.maxHeight, 16, 8640, null);
  const audioBitrate = parseBitrate("--audio-bitrate", args.audioBitrate, "128k");
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();

  const data = await runCompressBatch(ctx, args, {
    exts: VIDEO_EXTENSIONS,
    defaultDirName: "min",
    outputExt: () => `.${format}`,
    one: (input, output) =>
      compressOne(ffmpeg, ffprobe, input, output, {
        crf,
        preset,
        codec,
        format,
        maxHeight,
        audioBitrate,
      }),
  });
  if ("results" in data) {
    return {
      ...data,
      ...sumSaved(data.results),
      crf,
      preset,
      codec,
      format,
      maxHeight,
      audioBitrate,
    };
  }
  return { ...data, crf, preset, codec, format, maxHeight, audioBitrate };
}
