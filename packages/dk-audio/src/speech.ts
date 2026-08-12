import { AIProviderError, type AIProvider } from "@dkplus/ai-core";
import {
  CliError,
  parseTranscript,
  type SourceFingerprint,
  type Transcript
} from "@dkplus/contracts";
import { fingerprintFile } from "@dkplus/media-core";
import { z } from "zod";

export interface AudioTranscriptionTask {
  feature: "audio.speech.transcribe";
  audioPath: string;
  sourceFingerprint: SourceFingerprint;
  language?: string;
}

export interface AudioTranscriber {
  transcribe(task: AudioTranscriptionTask): Promise<unknown>;
}

export interface TranscribeAudioOptions {
  transcriber?: AudioTranscriber;
  language?: string;
}

export interface TranscriptTranslationTask {
  transcript: Transcript;
  targetLanguage: string;
}

export interface TranscriptTranslator {
  translate(task: TranscriptTranslationTask): Promise<unknown>;
}

export interface TranslateTranscriptOptions {
  targetLanguage: string;
  translator?: TranscriptTranslator;
}

export interface TranslateAudioOptions extends TranslateTranscriptOptions, TranscribeAudioOptions {}

export const transcriptSummarySchema = z
  .object({
    summary: z.string().min(1),
    topics: z.array(z.string()),
    keyPoints: z.array(z.string()),
    participants: z.array(z.string()),
    decisions: z.array(z.string()),
    questions: z.array(z.string())
  })
  .strict();

export type TranscriptSummary = z.infer<typeof transcriptSummarySchema>;

export interface SummarizeTranscriptOptions {
  provider: AIProvider;
}

function fingerprintMatches(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function requireNonEmptyLanguage(value: string): string {
  if (value.trim().length === 0) {
    throw new CliError({
      code: "INVALID_ARGUMENT",
      message: "Target language must be a non-empty string."
    });
  }
  return value;
}

function transcriptSourceMismatch(): CliError {
  return new CliError({
    code: "ARTIFACT_SOURCE_MISMATCH",
    message: "Transcript source fingerprint does not match the requested audio source."
  });
}

function canonicalTranscriptJson(transcript: Transcript): string {
  return JSON.stringify({
    kind: transcript.kind,
    schemaVersion: transcript.schemaVersion,
    sourceFingerprint: transcript.sourceFingerprint,
    language: transcript.language,
    segments: transcript.segments
  });
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

export async function transcribeAudio(
  audioPath: string,
  options: TranscribeAudioOptions = {}
): Promise<Transcript> {
  if (options.transcriber === undefined) {
    throw new CliError({
      code: "AUDIO_TRANSCRIBER_UNAVAILABLE",
      message: "Raw audio transcription requires a configured audio transcriber adapter."
    });
  }

  const sourceFingerprint = await fingerprintFile(audioPath);
  const transcript = parseTranscript(
    await options.transcriber.transcribe({
      feature: "audio.speech.transcribe",
      audioPath,
      sourceFingerprint,
      ...(options.language === undefined ? {} : { language: options.language })
    })
  );

  if (!fingerprintMatches(transcript.sourceFingerprint, sourceFingerprint)) {
    throw transcriptSourceMismatch();
  }
  return transcript;
}

export async function translateTranscript(
  input: unknown,
  options: TranslateTranscriptOptions
): Promise<Transcript> {
  const transcript = parseTranscript(input);
  const targetLanguage = requireNonEmptyLanguage(options.targetLanguage);
  if (options.translator === undefined) {
    throw new CliError({
      code: "AUDIO_TRANSLATOR_UNAVAILABLE",
      message: "Transcript translation requires a configured translator adapter."
    });
  }

  const translated = parseTranscript(
    await options.translator.translate({ transcript, targetLanguage })
  );
  if (!fingerprintMatches(translated.sourceFingerprint, transcript.sourceFingerprint)) {
    throw transcriptSourceMismatch();
  }
  return translated;
}

/**
 * Internal CLI composition for raw-audio translation. This module-level export
 * is intentionally not re-exported by the package root.
 */
export async function translateAudio(
  audioPath: string,
  options: TranslateAudioOptions
): Promise<Transcript> {
  const transcript = await transcribeAudio(audioPath, {
    transcriber: options.transcriber,
    ...(options.language === undefined ? {} : { language: options.language })
  });
  return translateTranscript(transcript, {
    targetLanguage: options.targetLanguage,
    translator: options.translator
  });
}

export async function summarizeTranscript(
  input: unknown,
  options: SummarizeTranscriptOptions
): Promise<TranscriptSummary> {
  const transcript = parseTranscript(input);
  try {
    return await options.provider.execute({
      feature: "audio.speech.summarize",
      prompt: `Summarize this canonical transcript as JSON.\n${canonicalTranscriptJson(transcript)}`,
      responseSchema: transcriptSummarySchema
    });
  } catch (error) {
    throw providerFailure(error);
  }
}
