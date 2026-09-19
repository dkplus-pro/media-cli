import { run } from "./proc.mjs";

export function runFfmpeg(ffmpegPath, args, opts = {}) {
  // -nostdin 防止 ffmpeg 从 stdin 读交互输入导致管道挂起；-y 防止覆盖询问
  return run(ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], {
    ...opts,
    source: "ffmpeg",
  });
}

export function runFfprobe(ffprobePath, args, opts = {}) {
  return run(ffprobePath, ["-v", "error", ...args], { ...opts, source: "ffmpeg" });
}

export async function probeDuration(ffprobePath, file) {
  const { stdout } = await runFfprobe(ffprobePath, [
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);
  try {
    const duration = Number(JSON.parse(stdout).format.duration);
    if (!Number.isFinite(duration)) throw new Error("not finite");
    return duration;
  } catch {
    throw Object.assign(new Error(`无法读取时长：${file}`), {
      code: "E_PROVIDER_ERROR",
      details: { source: "ffmpeg", stderr: stdout.slice(0, 200) },
    });
  }
}

export async function probeImageSize(ffprobePath, file) {
  const { stdout } = await runFfprobe(ffprobePath, [
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    file,
  ]);
  const stream = JSON.parse(stdout)?.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw Object.assign(new Error(`无法读取图片尺寸：${file}`), {
      code: "E_PROVIDER_ERROR",
      details: { source: "ffmpeg", stderr: stdout.slice(0, 200) },
    });
  }
  return { width: stream.width, height: stream.height };
}

// 探测 ffmpeg 是否编译了 drawtext 滤镜（部分精简构建不含 libfreetype）
export async function hasDrawtext(ffmpegPath) {
  try {
    const { stdout } = await run(ffmpegPath, ["-hide_banner", "-filters"], { source: "ffmpeg" });
    return /\bdrawtext\b/.test(stdout);
  } catch {
    return false;
  }
}
