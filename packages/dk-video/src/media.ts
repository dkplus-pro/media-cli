import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import {
  CliError,
  parseTranscript,
  type SourceFingerprint,
  type Transcript
} from "@dkplus/contracts";
import { transcribeAudio, type AudioTranscriber } from "@dkplus/dk-audio";
import {
  createFilmstrip,
  extractAudio,
  fingerprintFile,
  probeAudio,
  probeVideo as probeMediaVideo,
  readImageMetadata,
  type AudioMetadata,
  type FilmstripOptions,
  type VideoMetadata
} from "@dkplus/media-core";
import { z } from "zod";

const sourceFingerprintSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();

const artifactSchema = z
  .object({
    kind: z.string().min(1),
    schemaVersion: z.literal("1.0"),
    sourceFingerprint: sourceFingerprintSchema
  })
  .strict();

export const videoProbeSchema = artifactSchema
  .extend({
    kind: z.literal("video-probe"),
    durationMs: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    codec: z.string().min(1),
    fps: z.number().positive(),
    frameCount: z.number().int().nonnegative().optional()
  })
  .strict();

export const videoAudioSchema = artifactSchema
  .extend({
    kind: z.literal("video-audio"),
    outputPath: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    codec: z.string().min(1),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
    bitRate: z.number().int().positive().optional()
  })
  .strict();

const filmstripImageSchema = z
  .object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    base64Data: z.string().min(1)
  })
  .strict();

export const videoFilmstripSchema = artifactSchema
  .extend({
    kind: z.literal("video-filmstrip"),
    outputPath: z.string().min(1),
    timestamps: z.tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative()
    ]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    image: filmstripImageSchema
  })
  .strict();

export type VideoProbe = z.infer<typeof videoProbeSchema>;
export type VideoAudio = z.infer<typeof videoAudioSchema>;
export type VideoFilmstrip = z.infer<typeof videoFilmstripSchema>;

export interface ExtractVideoAudioOptions {
  force?: boolean;
}

export interface ExtractVideoSubtitlesOptions {
  transcriber?: AudioTranscriber;
  language?: string;
}

function videoProbeArtifact(
  sourceFingerprint: SourceFingerprint,
  metadata: VideoMetadata
): VideoProbe {
  return videoProbeSchema.parse({
    kind: "video-probe",
    schemaVersion: "1.0",
    sourceFingerprint,
    ...metadata
  });
}

function videoAudioArtifact(
  sourceFingerprint: SourceFingerprint,
  outputPath: string,
  metadata: AudioMetadata
): VideoAudio {
  return videoAudioSchema.parse({
    kind: "video-audio",
    schemaVersion: "1.0",
    sourceFingerprint,
    outputPath,
    ...metadata
  });
}

function mimeTypeForFormat(
  format: "jpeg" | "png" | "webp"
): "image/jpeg" | "image/png" | "image/webp" {
  const mimeTypes: Record<"jpeg" | "png" | "webp", "image/jpeg" | "image/png" | "image/webp"> = {
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
  };
  return mimeTypes[format];
}

function imageFormatFromPath(outputPath: string): "jpeg" | "png" | "webp" | undefined {
  const extension = extname(outputPath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "jpeg";
  }
  if (extension === ".png") {
    return "png";
  }
  if (extension === ".webp") {
    return "webp";
  }
  return undefined;
}

export async function probeVideo(videoPath: string): Promise<VideoProbe> {
  const [sourceFingerprint, metadata] = await Promise.all([
    fingerprintFile(videoPath),
    probeMediaVideo(videoPath)
  ]);
  return videoProbeArtifact(sourceFingerprint, metadata);
}

export async function extractVideoAudio(
  videoPath: string,
  outputPath: string,
  options: ExtractVideoAudioOptions = {}
): Promise<VideoAudio> {
  const sourceFingerprintPromise = fingerprintFile(videoPath);
  await extractAudio(videoPath, outputPath, { force: options.force });
  const [sourceFingerprint, metadata] = await Promise.all([
    sourceFingerprintPromise,
    probeAudio(outputPath)
  ]);
  return videoAudioArtifact(sourceFingerprint, outputPath, metadata);
}

export async function createVideoFilmstrip(
  videoPath: string,
  outputPath: string,
  options: Pick<FilmstripOptions, "timestamps" | "width" | "height">
): Promise<VideoFilmstrip> {
  const sourceFingerprintPromise = fingerprintFile(videoPath);
  const result = await createFilmstrip(videoPath, outputPath, options);
  const [sourceFingerprint, bytes, metadata] = await Promise.all([
    sourceFingerprintPromise,
    readFile(outputPath),
    readImageMetadata(outputPath)
  ]);
  const expectedFormat = imageFormatFromPath(outputPath);
  if (expectedFormat === undefined || expectedFormat !== metadata.format) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "Filmstrip output must be a JPEG, PNG, or WebP image."
    });
  }
  return videoFilmstripSchema.parse({
    kind: "video-filmstrip",
    schemaVersion: "1.0",
    sourceFingerprint,
    outputPath: result.outputPath,
    timestamps: result.timestamps,
    width: result.width,
    height: result.height,
    image: { mimeType: mimeTypeForFormat(metadata.format), base64Data: bytes.toString("base64") }
  });
}

export async function extractVideoSubtitles(
  videoPath: string,
  options: ExtractVideoSubtitlesOptions = {}
): Promise<Transcript> {
  const directory = await mkdtemp(join(tmpdir(), "dk-video-subtitles-"));
  const audioPath = join(directory, "audio.wav");
  try {
    const sourceFingerprintPromise = fingerprintFile(videoPath);
    await extractAudio(videoPath, audioPath, { force: true });
    const [sourceFingerprint, transcript] = await Promise.all([
      sourceFingerprintPromise,
      transcribeAudio(audioPath, { transcriber: options.transcriber, language: options.language })
    ]);
    return parseTranscript({ ...transcript, sourceFingerprint });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
