import { readFile } from "node:fs/promises";

import { AIProviderError, type AIProvider } from "@dkplus/ai-core";
import {
  CliError,
  parseTranscript,
  type SourceFingerprint,
  type Transcript
} from "@dkplus/contracts";
import { fingerprintFile } from "@dkplus/media-core";
import { z } from "zod";

import {
  videoAudioSchema,
  videoFilmstripSchema,
  videoProbeSchema,
  type VideoAudio,
  type VideoFilmstrip,
  type VideoProbe
} from "./media.js";

const sourceFingerprintSchema = z
  .object({ algorithm: z.literal("sha256"), value: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();

const contentArtifactSchema = z
  .object({
    kind: z.string().min(1),
    schemaVersion: z.literal("1.0"),
    sourceFingerprint: sourceFingerprintSchema
  })
  .strict();

export const videoContentSummarySchema = contentArtifactSchema
  .extend({
    kind: z.literal("video-content-summary"),
    summary: z.string().min(1),
    topics: z.array(z.string().min(1)),
    keyPoints: z.array(z.string().min(1))
  })
  .strict();

export const videoContentKeywordsSchema = contentArtifactSchema
  .extend({ kind: z.literal("video-content-keywords"), keywords: z.array(z.string().min(1)) })
  .strict();

const highlightSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    title: z.string().min(1),
    rationale: z.string().min(1)
  })
  .strict()
  .refine((value) => value.endMs >= value.startMs, {
    message: "endMs must be at or after startMs"
  });

export const videoContentHighlightsSchema = contentArtifactSchema
  .extend({ kind: z.literal("video-content-highlights"), highlights: z.array(highlightSchema) })
  .strict();

export const videoAnalysisSchema = z
  .object({
    probe: videoProbeSchema,
    audio: videoAudioSchema,
    filmstrip: videoFilmstripSchema,
    subtitles: z.custom<Transcript>(),
    summary: videoContentSummarySchema,
    keywords: videoContentKeywordsSchema,
    highlights: videoContentHighlightsSchema
  })
  .strict();

export type VideoContentSummary = z.infer<typeof videoContentSummarySchema>;
export type VideoContentKeywords = z.infer<typeof videoContentKeywordsSchema>;
export type VideoContentHighlights = z.infer<typeof videoContentHighlightsSchema>;
export type VideoAnalysis = {
  probe: VideoProbe;
  audio: VideoAudio;
  filmstrip: VideoFilmstrip;
  subtitles: Transcript;
  summary: VideoContentSummary;
  keywords: VideoContentKeywords;
  highlights: VideoContentHighlights;
};

export interface VideoContentOptions {
  transcript: unknown;
  filmstrip: unknown;
  provider: AIProvider;
}

export interface AnalyzeVideoOptions {
  dependencies?: Partial<VideoAnalysis>;
}

function providerFailure(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof AIProviderError) {
    return new CliError({ code: error.code, message: error.message });
  }
  return new CliError({
    code: "AI_PROVIDER_RESPONSE_INVALID",
    message: "The AI provider returned an invalid response."
  });
}

function artifactError(): CliError {
  return new CliError({ code: "INVALID_ARTIFACT", message: "Video artifact data is invalid." });
}

function sourceMismatch(): CliError {
  return new CliError({
    code: "ARTIFACT_SOURCE_MISMATCH",
    message: "Video dependency source fingerprint does not match the requested video."
  });
}

function missingArtifact(name: string): CliError {
  return new CliError({
    code: "MISSING_REQUIRED_ARTIFACT",
    message: `analyze requires the ${name} artifact.`,
    details: { artifact: name }
  });
}

function fingerprintsMatch(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function requireSourceFingerprint(
  artifact: { sourceFingerprint: SourceFingerprint },
  expected: SourceFingerprint
): void {
  if (!fingerprintsMatch(artifact.sourceFingerprint, expected)) {
    throw sourceMismatch();
  }
}

function parseArtifact<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw artifactError();
  }
  return parsed.data;
}

function canonicalTimestampedTranscript(transcript: Transcript): string {
  return transcript.segments
    .map(
      (segment) =>
        `[${formatTimestamp(segment.startMs)}-${formatTimestamp(segment.endMs)}] ${segment.text}`
    )
    .join("\n");
}

function formatTimestamp(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
    .toString()
    .padStart(2, "0");
  const remainder = (milliseconds % 1_000).toString().padStart(3, "0");
  return `${minutes}:${seconds}.${remainder}`;
}

async function loadContentInputs(
  videoPath: string,
  options: VideoContentOptions
): Promise<{
  sourceFingerprint: SourceFingerprint;
  transcript: Transcript;
  filmstrip: VideoFilmstrip;
}> {
  const [sourceFingerprint, transcript] = await Promise.all([
    fingerprintFile(videoPath),
    Promise.resolve(parseTranscript(options.transcript))
  ]);
  const filmstrip = parseArtifact(videoFilmstripSchema, options.filmstrip);
  requireSourceFingerprint(transcript, sourceFingerprint);
  requireSourceFingerprint(filmstrip, sourceFingerprint);
  return { sourceFingerprint, transcript, filmstrip };
}

async function executeContentFeature<Result>(
  videoPath: string,
  options: VideoContentOptions,
  feature: "video.content.summary" | "video.content.keywords" | "video.content.highlights",
  instruction: string,
  responseSchema: z.ZodType<Result>
): Promise<{ sourceFingerprint: SourceFingerprint; response: Result }> {
  const { sourceFingerprint, transcript, filmstrip } = await loadContentInputs(videoPath, options);
  try {
    const response = await options.provider.execute({
      feature,
      prompt: `${instruction}\nTimestamped canonical transcript:\n${canonicalTimestampedTranscript(transcript)}\nVideo source fingerprint: ${JSON.stringify(sourceFingerprint)}\nFilmstrip artifact: ${JSON.stringify({ outputPath: filmstrip.outputPath, timestamps: filmstrip.timestamps, width: filmstrip.width, height: filmstrip.height })}`,
      images: [filmstrip.image],
      responseSchema
    });
    return { sourceFingerprint, response };
  } catch (error) {
    throw providerFailure(error);
  }
}

export async function summarizeVideoContent(
  videoPath: string,
  options: VideoContentOptions
): Promise<VideoContentSummary> {
  const { sourceFingerprint, response } = await executeContentFeature(
    videoPath,
    options,
    "video.content.summary",
    "Summarize this video only from the transcript and referenced filmstrip image as JSON.",
    videoContentSummarySchema.pick({ summary: true, topics: true, keyPoints: true })
  );
  return videoContentSummarySchema.parse({
    kind: "video-content-summary",
    schemaVersion: "1.0",
    sourceFingerprint,
    ...response
  });
}

export async function extractVideoKeywords(
  videoPath: string,
  options: VideoContentOptions
): Promise<VideoContentKeywords> {
  const { sourceFingerprint, response } = await executeContentFeature(
    videoPath,
    options,
    "video.content.keywords",
    "Extract concise video keywords only from the transcript and referenced filmstrip image as JSON.",
    videoContentKeywordsSchema.pick({ keywords: true })
  );
  return videoContentKeywordsSchema.parse({
    kind: "video-content-keywords",
    schemaVersion: "1.0",
    sourceFingerprint,
    ...response
  });
}

export async function extractVideoHighlights(
  videoPath: string,
  options: VideoContentOptions
): Promise<VideoContentHighlights> {
  const { sourceFingerprint, response } = await executeContentFeature(
    videoPath,
    options,
    "video.content.highlights",
    "Identify timestamped video highlights only from the transcript and referenced filmstrip image as JSON.",
    videoContentHighlightsSchema.pick({ highlights: true })
  );
  return videoContentHighlightsSchema.parse({
    kind: "video-content-highlights",
    schemaVersion: "1.0",
    sourceFingerprint,
    ...response
  });
}

export async function analyzeVideo(
  videoPath: string,
  options: AnalyzeVideoOptions
): Promise<VideoAnalysis> {
  const dependencies = options.dependencies ?? {};
  const probe = dependencies.probe;
  const audio = dependencies.audio;
  const filmstrip = dependencies.filmstrip;
  const subtitles = dependencies.subtitles;
  const summary = dependencies.summary;
  const keywords = dependencies.keywords;
  const highlights = dependencies.highlights;
  if (probe === undefined) throw missingArtifact("probe");
  if (audio === undefined) throw missingArtifact("audio");
  if (filmstrip === undefined) throw missingArtifact("filmstrip");
  if (subtitles === undefined) throw missingArtifact("subtitles");
  if (summary === undefined) throw missingArtifact("summary");
  if (keywords === undefined) throw missingArtifact("keywords");
  if (highlights === undefined) throw missingArtifact("highlights");

  const sourceFingerprint = await fingerprintFile(videoPath);
  const parsedProbe = parseArtifact(videoProbeSchema, probe);
  const parsedAudio = parseArtifact(videoAudioSchema, audio);
  const parsedFilmstrip = parseArtifact(videoFilmstripSchema, filmstrip);
  const parsedSubtitles = parseTranscript(subtitles);
  const parsedSummary = parseArtifact(videoContentSummarySchema, summary);
  const parsedKeywords = parseArtifact(videoContentKeywordsSchema, keywords);
  const parsedHighlights = parseArtifact(videoContentHighlightsSchema, highlights);
  for (const artifact of [
    parsedProbe,
    parsedAudio,
    parsedFilmstrip,
    parsedSubtitles,
    parsedSummary,
    parsedKeywords,
    parsedHighlights
  ]) {
    requireSourceFingerprint(artifact, sourceFingerprint);
  }
  return {
    probe: parsedProbe,
    audio: parsedAudio,
    filmstrip: parsedFilmstrip,
    subtitles: parsedSubtitles,
    summary: parsedSummary,
    keywords: parsedKeywords,
    highlights: parsedHighlights
  };
}

export async function readVideoArtifact<T = unknown>(input: string): Promise<T> {
  try {
    return JSON.parse(input.trim().startsWith("{") ? input : await readFile(input, "utf8")) as T;
  } catch {
    throw artifactError();
  }
}
