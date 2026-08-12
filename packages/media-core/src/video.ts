import { prepareMediaOutput, type MediaOutputOptions } from "./output.js";
import { mediaProcessFailed, runMediaTool, type MediaProcessOptions } from "./process.js";

export interface VideoMetadata {
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  frameCount?: number;
}

export interface FilmstripOptions extends MediaProcessOptions, MediaOutputOptions {
  timestamps: readonly [number, number, number, number];
  width: number;
  height: number;
}

export interface FilmstripResult {
  outputPath: string;
  timestamps: readonly [number, number, number, number];
  width: number;
  height: number;
}

interface ProbePayload {
  format?: { duration?: string };
  streams?: Array<{
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    nb_frames?: string;
  }>;
}

function parseFraction(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const [numerator, denominator] = value.split("/").map(Number);
  if (numerator === undefined || denominator === undefined || denominator === 0) {
    return undefined;
  }
  const parsed = numerator / denominator;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseVideoMetadata(stdout: string): VideoMetadata {
  let payload: ProbePayload;
  try {
    payload = JSON.parse(stdout) as ProbePayload;
  } catch {
    throw mediaProcessFailed();
  }

  const stream = payload.streams?.[0];
  const durationSeconds = Number(payload.format?.duration);
  const width = stream?.width;
  const height = stream?.height;
  const fps = parseFraction(stream?.avg_frame_rate) ?? parseFraction(stream?.r_frame_rate);
  if (
    !stream?.codec_name ||
    !Number.isFinite(durationSeconds) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    fps === undefined
  ) {
    throw mediaProcessFailed();
  }

  const frameCount = stream.nb_frames === undefined ? undefined : Number(stream.nb_frames);
  const normalizedFrameCount =
    typeof frameCount === "number" && Number.isFinite(frameCount)
      ? Math.round(frameCount)
      : undefined;
  return {
    durationMs: Math.round(durationSeconds * 1000),
    width: Math.round(width),
    height: Math.round(height),
    codec: stream.codec_name,
    fps,
    ...(normalizedFrameCount === undefined ? {} : { frameCount: normalizedFrameCount })
  };
}

function validateFilmstripOptions(options: FilmstripOptions): void {
  if (
    !Number.isInteger(options.width) ||
    options.width <= 1 ||
    !Number.isInteger(options.height) ||
    options.height <= 1
  ) {
    throw mediaProcessFailed();
  }
  if (
    options.width % 2 !== 0 ||
    options.height % 2 !== 0 ||
    options.timestamps.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw mediaProcessFailed();
  }
}

export async function probeVideo(
  path: string,
  options: MediaProcessOptions = {}
): Promise<VideoMetadata> {
  const result = await runMediaTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:stream=codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames",
      "-of",
      "json",
      path
    ],
    options
  );
  return parseVideoMetadata(result.stdout);
}

export async function createFilmstrip(
  inputPath: string,
  outputPath: string,
  options: FilmstripOptions
): Promise<FilmstripResult> {
  validateFilmstripOptions(options);
  const output = await prepareMediaOutput(inputPath, outputPath, "Filmstrip output", options);
  const tileWidth = options.width / 2;
  const tileHeight = options.height / 2;
  const [first, second, third, fourth] = options.timestamps;
  const filter = [
    `[0:v]scale=${tileWidth}:${tileHeight},setsar=1[a]`,
    `[1:v]scale=${tileWidth}:${tileHeight},setsar=1[b]`,
    `[2:v]scale=${tileWidth}:${tileHeight},setsar=1[c]`,
    `[3:v]scale=${tileWidth}:${tileHeight},setsar=1[d]`,
    `[a][b][c][d]xstack=inputs=4:layout=0_0|${tileWidth}_0|0_${tileHeight}|${tileWidth}_${tileHeight}`
  ].join(";");

  let failure: unknown;
  let hasFailure = false;
  try {
    await runMediaTool(
      "ffmpeg",
      [
        "-n",
        "-v",
        "error",
        "-ss",
        String(first),
        "-i",
        inputPath,
        "-ss",
        String(second),
        "-i",
        inputPath,
        "-ss",
        String(third),
        "-i",
        inputPath,
        "-ss",
        String(fourth),
        "-i",
        inputPath,
        "-filter_complex",
        filter,
        "-frames:v",
        "1",
        "-update",
        "1",
        output.temporaryPath
      ],
      options
    );
    await output.publish();
  } catch (error) {
    failure = error;
    hasFailure = true;
  }

  try {
    await output.cleanup();
  } catch (cleanupError) {
    if (!hasFailure) {
      failure = cleanupError;
      hasFailure = true;
    }
  }

  if (hasFailure) {
    throw failure;
  }

  return {
    outputPath,
    timestamps: options.timestamps,
    width: options.width,
    height: options.height
  };
}
