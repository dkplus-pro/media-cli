import { AIProviderError, type AIProvider } from "@dkplus/ai-core";
import { CliError, type SourceFingerprint } from "@dkplus/contracts";
import { fingerprintFile, probeAudio } from "@dkplus/media-core";
import { z } from "zod";

export interface MusicMetadata {
  kind: "music-metadata";
  schemaVersion: "1.0";
  sourceFingerprint: SourceFingerprint;
  durationMs: number;
  codec: string;
  sampleRate: number;
  channels: number;
  bitRate: number | null;
  bpm: null;
  key: null;
  mode: null;
  loudness: null;
}

export const musicEmotionSchema = z
  .object({
    primaryEmotion: z.string().min(1),
    secondaryEmotions: z.array(z.string()),
    valence: z.number().min(-1).max(1),
    arousal: z.number().min(0).max(1),
    tension: z.number().min(0).max(1)
  })
  .strict();

export interface MusicEmotion extends z.infer<typeof musicEmotionSchema> {
  kind: "music-emotion";
  schemaVersion: "1.0";
  sourceFingerprint: SourceFingerprint;
}

export interface AnalyzeMusicEmotionOptions {
  provider: AIProvider;
  metadata?: MusicMetadata;
}

export interface AnalyzeMusicOptions {
  provider: AIProvider;
}

export interface MusicAnalysis {
  metadata: MusicMetadata;
  emotion: MusicEmotion;
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

export async function readAudioMetadata(audioPath: string): Promise<MusicMetadata> {
  const [sourceFingerprint, metadata] = await Promise.all([
    fingerprintFile(audioPath),
    probeAudio(audioPath)
  ]);
  return {
    kind: "music-metadata",
    schemaVersion: "1.0",
    sourceFingerprint,
    durationMs: metadata.durationMs,
    codec: metadata.codec,
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    bitRate: metadata.bitRate ?? null,
    bpm: null,
    key: null,
    mode: null,
    loudness: null
  };
}

export async function analyzeMusicEmotion(
  audioPath: string,
  options: AnalyzeMusicEmotionOptions
): Promise<MusicEmotion> {
  const metadata = options.metadata ?? (await readAudioMetadata(audioPath));
  try {
    const emotion = await options.provider.execute({
      feature: "audio.music.emotion",
      prompt: `Analyze the emotion of this local audio asset from its deterministic metadata as JSON.\n${JSON.stringify(metadata)}`,
      responseSchema: musicEmotionSchema
    });
    return {
      kind: "music-emotion",
      schemaVersion: "1.0",
      sourceFingerprint: metadata.sourceFingerprint,
      ...emotion
    };
  } catch (error) {
    throw providerFailure(error);
  }
}

export async function analyzeMusic(
  audioPath: string,
  options: AnalyzeMusicOptions
): Promise<MusicAnalysis> {
  const metadata = await readAudioMetadata(audioPath);
  const emotion = await analyzeMusicEmotion(audioPath, { provider: options.provider, metadata });
  return { metadata, emotion };
}
