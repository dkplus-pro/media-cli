import { readFile } from "node:fs/promises";
import { run } from "./bin.mjs";
import { cliError } from "./errors.mjs";
import { parseSilences } from "./segments.mjs";

const SILENCE_NOISE_DB = "-35dB";
const SILENCE_MIN_SEC = 0.3;

export async function probeDuration(ffprobe, input) {
  const { stdout } = await run(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input],
    { source: "ffprobe" },
  );
  const durationSec = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw cliError("E_PROVIDER_ERROR", `无法读取输入时长：${input}`, {
      source: "ffprobe",
      input,
    });
  }
  return durationSec;
}

// 无静音轨（如连续音乐）时 silencedetect 不报错，返回空数组由分段器退化为定长切
export async function detectSilences(ffmpeg, input) {
  const { stderr } = await run(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      input,
      "-vn",
      "-af",
      `silencedetect=noise=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_SEC}`,
      "-f",
      "null",
      "-",
    ],
    { source: "ffmpeg" },
  );
  return parseSilences(stderr);
}

// 送模型前统一重采样：单声道 16k / 48k mp3，负载小且识别最稳
export async function extractClipBase64(ffmpeg, input, { start, end, outPath }) {
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      start.toFixed(3),
      "-i",
      input,
      "-t",
      Math.max(0.05, end - start).toFixed(3),
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "48k",
      outPath,
    ],
    { source: "ffmpeg" },
  );
  const buf = await readFile(outPath).catch(() => null);
  if (!buf || buf.length === 0) {
    throw cliError("E_PROVIDER_ERROR", `ffmpeg 未切出音频片段（${start}-${end}s）`, {
      source: "ffmpeg",
      start,
      end,
    });
  }
  return buf.toString("base64");
}
