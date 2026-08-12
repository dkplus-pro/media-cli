import { prepareMediaOutput, type MediaOutputOptions } from "./output.js";
import { mediaProcessFailed, runMediaTool, type MediaProcessOptions } from "./process.js";

export interface AudioMetadata {
  durationMs: number;
  codec: string;
  sampleRate: number;
  channels: number;
  bitRate?: number;
}

export interface ExtractAudioOptions extends MediaProcessOptions, MediaOutputOptions {}

interface ProbePayload {
  format?: { duration?: string; bit_rate?: string };
  streams?: Array<{
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    bit_rate?: string;
  }>;
}

function finiteNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAudioMetadata(stdout: string): AudioMetadata {
  let payload: ProbePayload;
  try {
    payload = JSON.parse(stdout) as ProbePayload;
  } catch {
    throw mediaProcessFailed();
  }

  const stream = payload.streams?.[0];
  const durationSeconds = finiteNumber(payload.format?.duration);
  const sampleRate = finiteNumber(stream?.sample_rate);
  const channels = finiteNumber(stream?.channels);
  if (
    !stream?.codec_name ||
    durationSeconds === undefined ||
    sampleRate === undefined ||
    channels === undefined
  ) {
    throw mediaProcessFailed();
  }

  const bitRate = finiteNumber(stream.bit_rate ?? payload.format?.bit_rate);
  return {
    durationMs: Math.round(durationSeconds * 1000),
    codec: stream.codec_name,
    sampleRate: Math.round(sampleRate),
    channels: Math.round(channels),
    ...(bitRate === undefined ? {} : { bitRate: Math.round(bitRate) })
  };
}

export async function probeAudio(
  path: string,
  options: MediaProcessOptions = {}
): Promise<AudioMetadata> {
  const result = await runMediaTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "format=duration,bit_rate:stream=codec_name,sample_rate,channels,bit_rate",
      "-of",
      "json",
      path
    ],
    options
  );
  return parseAudioMetadata(result.stdout);
}

export async function extractAudio(
  inputPath: string,
  outputPath: string,
  options: ExtractAudioOptions = {}
): Promise<void> {
  const output = await prepareMediaOutput(inputPath, outputPath, "Audio output", options);
  try {
    await runMediaTool(
      "ffmpeg",
      [
        "-n",
        "-v",
        "error",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "44100",
        output.temporaryPath
      ],
      options
    );
    await output.publish();
  } finally {
    await output.cleanup();
  }
}
