import { CliError } from "./cli.js";
import type { SourceFingerprint } from "./artifacts.js";

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  kind: "transcript";
  schemaVersion: "1.0";
  sourceFingerprint: SourceFingerprint;
  language: string;
  segments: TranscriptSegment[];
}

function invalidTranscript(details: unknown): CliError {
  return new CliError({
    code: "INVALID_TRANSCRIPT",
    message: "Transcript data is invalid.",
    details
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceFingerprint(value: unknown): value is SourceFingerprint {
  return (
    isRecord(value) &&
    value["algorithm"] === "sha256" &&
    typeof value["value"] === "string" &&
    /^[a-f0-9]{64}$/iu.test(value["value"])
  );
}

function parseSegment(value: unknown, index: number): TranscriptSegment {
  if (!isRecord(value)) {
    throw invalidTranscript({ field: `segments[${index}]`, reason: "must be an object" });
  }

  const id = value["id"];
  const startMs = value["startMs"];
  const endMs = value["endMs"];
  const text = value["text"];
  if (typeof id !== "string" || id.length === 0) {
    throw invalidTranscript({ field: `segments[${index}].id`, reason: "must be a non-empty string" });
  }
  if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0 || !Number.isInteger(startMs)) {
    throw invalidTranscript({ field: `segments[${index}].startMs`, reason: "must be a non-negative integer" });
  }
  if (
    typeof endMs !== "number" ||
    !Number.isFinite(endMs) ||
    endMs < startMs ||
    !Number.isInteger(endMs)
  ) {
    throw invalidTranscript({ field: `segments[${index}].endMs`, reason: "must be an integer at or after startMs" });
  }
  if (typeof text !== "string") {
    throw invalidTranscript({ field: `segments[${index}].text`, reason: "must be a string" });
  }

  return { id, startMs, endMs, text };
}

export function parseTranscript(value: unknown): Transcript {
  if (!isRecord(value)) {
    throw invalidTranscript({ reason: "must be an object" });
  }

  const { kind, schemaVersion, sourceFingerprint, language, segments } = value;
  if (kind !== "transcript" || schemaVersion !== "1.0") {
    throw invalidTranscript({ field: "kind/schemaVersion", reason: "must identify transcript schema 1.0" });
  }
  if (!isSourceFingerprint(sourceFingerprint)) {
    throw invalidTranscript({ field: "sourceFingerprint", reason: "must be a SHA-256 fingerprint" });
  }
  if (typeof language !== "string" || language.length === 0) {
    throw invalidTranscript({ field: "language", reason: "must be a non-empty string" });
  }
  if (!Array.isArray(segments)) {
    throw invalidTranscript({ field: "segments", reason: "must be an array" });
  }

  return {
    kind,
    schemaVersion,
    sourceFingerprint,
    language,
    segments: segments.map(parseSegment)
  };
}
