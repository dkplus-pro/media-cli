import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compressAudio } from "./lib/compress-audio.mjs";
import { compressVideo } from "./lib/compress-video.mjs";
import { cliError } from "./lib/errors.mjs";
import { hasDrawtext, probeDuration, probeImageSize, runFfmpeg } from "./lib/ffmpeg.mjs";
import {
  resolveFfmpeg,
  resolveFfprobe,
  resolveWhisper,
  resolveWhisperModel,
} from "./lib/paths.mjs";
import { countSegments, transcribeToSrt } from "./lib/whisper.mjs";

function requireInput(args) {
  if (!args.input) {
    throw cliError("E_MISSING_ARGUMENT", "缺少必填 --input", { option: "--input" });
  }
  return args.input;
}

function requireOneOf(value, allowed, option) {
  if (!allowed.includes(value)) {
    throw cliError("E_INVALID_OPTION", `${option} 仅支持 ${allowed.join("|")}，得到：${value}`, {
      option,
      value,
    });
  }
  return value;
}

function clampCellWidth(raw) {
  const n = Math.round(Number(raw ?? 320));
  if (!Number.isFinite(n) || n <= 0) {
    throw cliError("E_INVALID_OPTION", `--cell-width 必须是数字，得到：${raw}`, {
      option: "--cell-width",
      value: raw,
    });
  }
  return Math.min(640, Math.max(160, n));
}

// select 按时间均匀采样（保留原始 pts 供 drawtext 显示真实时间点），缩放后烧时间戳再拼 4x4
function buildFilterChain(durationSec, cellWidth, withTimestamps) {
  const step = durationSec / 16;
  const select = `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${step})'`;
  const scale = `scale=${cellWidth}:-2`;
  const drawtext =
    "drawtext=text='%{pts\\:hms}':x=6:y=h-th-6:fontsize=h/14:fontcolor=white:box=1:boxcolor=black@0.5";
  const nodes = withTimestamps
    ? [select, scale, drawtext, "tile=4x4"]
    : [select, scale, "tile=4x4"];
  return nodes.join(",");
}

async function filmstrip(ctx, args) {
  const input = requireInput(args);
  const format = requireOneOf(args.format ?? "jpg", ["jpg", "png"], "--format");
  const cellWidth = clampCellWidth(args.cellWidth);
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const durationSec = await probeDuration(ffprobe, input);
  if (!(durationSec > 0)) {
    throw cliError("E_INVALID_OPTION", `无法读取输入时长：${input}`, {
      option: "--input",
      value: input,
    });
  }
  const output = args.output ?? `${input}.filmstrip.${format}`;

  const drawtextOk = await hasDrawtext(ffmpeg);
  let usedDrawtext = false;
  if (drawtextOk) {
    try {
      await runFfmpeg(ffmpeg, [
        "-i",
        input,
        "-vf",
        buildFilterChain(durationSec, cellWidth, true),
        "-frames:v",
        "1",
        ...(format === "jpg" ? ["-q:v", "3"] : []),
        output,
      ]);
      usedDrawtext = true;
    } catch {
      // 滤镜存在但渲染可能失败（无 fontconfig/字体的精简构建），降级重试
      ctx.warnings.add({
        code: "E_MISSING_DEPENDENCY",
        message: "drawtext 渲染失败，时间戳已省略",
        plugin: "media-av",
      });
    }
  }
  if (!usedDrawtext) {
    if (!drawtextOk) {
      ctx.warnings.add({
        code: "E_MISSING_DEPENDENCY",
        message: "ffmpeg 未编译 drawtext，时间戳已省略",
        plugin: "media-av",
      });
    }
    await runFfmpeg(ffmpeg, [
      "-i",
      input,
      "-vf",
      buildFilterChain(durationSec, cellWidth, false),
      "-frames:v",
      "1",
      ...(format === "jpg" ? ["-q:v", "3"] : []),
      output,
    ]);
  }

  const info = await stat(output).catch(() => null);
  if (!info || info.size === 0) {
    throw cliError("E_PROVIDER_ERROR", "ffmpeg 未产出输出文件", { source: "ffmpeg", output });
  }
  const { width, height } = await probeImageSize(ffprobe, output);
  return { path: output, width, height, cells: 16, durationSec, timestamps: usedDrawtext };
}

// bitrate 仅对有损格式生效
const AUDIO_CODECS = {
  mp3: (bitrate) => ["-acodec", "libmp3lame", "-b:a", bitrate],
  m4a: (bitrate) => ["-acodec", "aac", "-b:a", bitrate],
  wav: () => ["-acodec", "pcm_s16le"],
  flac: () => ["-acodec", "flac"],
  ogg: () => ["-acodec", "libvorbis", "-q:a", "4"],
};

async function toAudio(_ctx, args) {
  const input = requireInput(args);
  const format = requireOneOf(args.format ?? "mp3", Object.keys(AUDIO_CODECS), "--format");
  const bitrate = args.bitrate ?? "192k";
  if (!/^[1-9]\d{0,3}k?$/.test(bitrate)) {
    throw cliError("E_INVALID_OPTION", `--bitrate 格式非法：${bitrate}（如 192k）`, {
      option: "--bitrate",
      value: bitrate,
    });
  }
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const durationSec = await probeDuration(ffprobe, input);
  const output = args.output ?? `${input}.${format}`;
  await runFfmpeg(ffmpeg, [
    "-i",
    input,
    "-vn",
    "-map",
    "a:0?",
    ...AUDIO_CODECS[format](bitrate),
    output,
  ]);
  const info = await stat(output).catch(() => null);
  if (!info || info.size === 0) {
    throw cliError("E_PROVIDER_ERROR", "ffmpeg 未产出输出文件", { source: "ffmpeg", output });
  }
  return { path: output, format, durationSec, bytes: info.size };
}

async function transcribe(_ctx, args) {
  const input = requireInput(args);
  const modelPath = resolveWhisperModel({ option: args.modelPath });
  const whisperBin = resolveWhisper();
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const durationSec = await probeDuration(ffprobe, input);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "media-av-"));
  try {
    const wavPath = path.join(tmp, "audio.wav");
    await runFfmpeg(ffmpeg, [
      "-i",
      input,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);
    const outPrefix = path.join(tmp, "out");
    await transcribeToSrt({
      whisperBin,
      modelPath,
      wavPath,
      outPrefix,
      language: args.language,
    });
    const srt = await readFile(`${outPrefix}.srt`, "utf8");
    const output = args.output ?? `${input}.srt`;
    await writeFile(output, srt);
    return {
      path: output,
      durationSec,
      segments: countSegments(srt),
      language: args.language ?? "auto",
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export default {
  name: "media-av",
  version: "0.1.0",
  commands: [
    {
      name: "media-filmstrip",
      description: "视频转 4×4 胶片流图（16 格拼图，含时间戳，供 AI 了解视频画面）",
      options: [
        { flags: "--input <path>", description: "输入视频路径" },
        { flags: "--output <path>", description: "输出图片路径（默认 <input>.filmstrip.jpg）" },
        { flags: "--cell-width <px>", description: "单格宽度 px（默认 320，范围 160–640）" },
        { flags: "--format <format>", description: "输出格式 jpg|png（默认 jpg）" },
      ],
      handler: filmstrip,
    },
    {
      name: "media-to-audio",
      description: "视频转音频（去掉视频轨，按指定格式编码）",
      options: [
        { flags: "--input <path>", description: "输入视频/音频路径" },
        { flags: "--output <path>", description: "输出音频路径（默认 <input>.<format>）" },
        { flags: "--format <format>", description: "mp3|m4a|wav|flac|ogg（默认 mp3）" },
        { flags: "--bitrate <rate>", description: "音频码率（默认 192k，仅 mp3/m4a 生效）" },
      ],
      handler: toAudio,
    },
    {
      name: "media-transcribe",
      description: "音频/视频转 SRT 字幕（本地 whisper.cpp，需 WHISPER_MODEL）",
      options: [
        { flags: "--input <path>", description: "输入音频/视频路径" },
        { flags: "--output <path>", description: "输出字幕路径（默认 <input>.srt）" },
        { flags: "--model-path <path>", description: "ggml 模型路径（默认取 WHISPER_MODEL）" },
        { flags: "--language <code>", description: "语言代码（默认 auto）" },
      ],
      handler: transcribe,
    },
    {
      name: "media-compress-video",
      description: "压缩视频体积（H.264/HEVC 重编码，默认不改分辨率），支持文件与文件夹批量",
      options: [
        {
          flags: "--input <path>",
          description: "输入视频文件或文件夹（mp4/mov/m4v/mkv/webm/avi/flv/wmv）",
        },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <name>.min.mp4，文件夹默认 ./min）",
        },
        { flags: "--crf <0-51>", description: "质量因子，越小质量越高体积越大（默认 26）" },
        {
          flags: "--preset <name>",
          description: "编码速度预设 ultrafast~veryslow（默认 medium，越慢压缩率越高）",
        },
        { flags: "--codec <name>", description: "h264|hevc（默认 h264；hevc 体积更小、编码更慢）" },
        {
          flags: "--max-height <px>",
          description: "可选降分辨率：高度上限，仅缩小不放大（如 720）",
        },
        { flags: "--audio-bitrate <rate>", description: "音轨码率（默认 128k）" },
        { flags: "--format <name>", description: "输出容器 mp4|mov|mkv（默认 mp4）" },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: compressVideo,
    },
    {
      name: "media-compress-audio",
      description: "压缩音频体积（重编码；wav/aiff 默认转无损 flac），支持文件与文件夹批量",
      options: [
        {
          flags: "--input <path>",
          description: "输入音频文件或文件夹（mp3/m4a/aac/ogg/opus/flac/wav/aiff）",
        },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <name>.min.<format>，文件夹默认 ./min）",
        },
        { flags: "--bitrate <rate>", description: "目标码率（默认 128k，仅有损格式生效）" },
        {
          flags: "--format <name>",
          description: "mp3|m4a|aac|opus|ogg|flac（默认：有损格式保持原样，无损源转 flac）",
        },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: compressAudio,
    },
  ],
};
