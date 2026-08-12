import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CliError,
  createErrorResult,
  createSuccessResult,
  parseTranscript
} from "../dist/index.js";

describe("CLI result contracts", () => {
  it("emits a stable success envelope", () => {
    assert.deepEqual(
      createSuccessResult({ command: "image content metadata", version: "0.1.0" }, { width: 640 }),
      {
        success: true,
        command: "image content metadata",
        version: "0.1.0",
        data: { width: 640 }
      }
    );
  });

  it("serializes IMAGE_NOT_FOUND as a typed failure envelope", () => {
    const error = new CliError({
      code: "IMAGE_NOT_FOUND",
      message: "Image was not found.",
      details: { path: "/missing/photo.jpg" }
    });

    assert.deepEqual(
      createErrorResult({ command: "image content metadata", version: "0.1.0" }, error),
      {
        success: false,
        command: "image content metadata",
        version: "0.1.0",
        error: {
          code: "IMAGE_NOT_FOUND",
          message: "Image was not found.",
          details: { path: "/missing/photo.jpg" }
        }
      }
    );
  });
});

describe("Transcript contract", () => {
  it("accepts a versioned transcript with a fingerprint and timestamped segments", () => {
    const transcript = parseTranscript({
      kind: "transcript",
      schemaVersion: "1.0",
      sourceFingerprint: {
        algorithm: "sha256",
        value: "a".repeat(64)
      },
      language: "en",
      segments: [
        { id: "seg-001", startMs: 0, endMs: 1200, text: "Hello world." },
        { id: "seg-002", startMs: 1200, endMs: 2400, text: "Goodbye." }
      ]
    });

    assert.equal(transcript.kind, "transcript");
    assert.equal(transcript.schemaVersion, "1.0");
    assert.equal(transcript.language, "en");
    assert.deepEqual(
      transcript.segments.map(({ startMs, endMs }) => ({ startMs, endMs })),
      [
        { startMs: 0, endMs: 1200 },
        { startMs: 1200, endMs: 2400 }
      ]
    );
  });

  it("rejects malformed segments with a typed CLI error", () => {
    assert.throws(
      () =>
        parseTranscript({
          kind: "transcript",
          schemaVersion: "1.0",
          sourceFingerprint: { algorithm: "sha256", value: "a".repeat(64) },
          language: "en",
          segments: [{ id: "seg-001", startMs: 1200, endMs: 0, text: "Backwards." }]
        }),
      (error) => error instanceof CliError && error.code === "INVALID_TRANSCRIPT"
    );
  });

  it("rejects overlapping and out-of-order segments", () => {
    assert.throws(
      () =>
        parseTranscript({
          kind: "transcript",
          schemaVersion: "1.0",
          sourceFingerprint: { algorithm: "sha256", value: "a".repeat(64) },
          language: "en",
          segments: [
            { id: "seg-001", startMs: 0, endMs: 1200, text: "First." },
            { id: "seg-002", startMs: 1000, endMs: 2000, text: "Overlaps." }
          ]
        }),
      (error) => error instanceof CliError && error.code === "INVALID_TRANSCRIPT"
    );
  });
});
