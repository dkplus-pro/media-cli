import type { CliResult, Transcript } from "../src/index.js";

const result: CliResult<{ width: number }> = {
  success: true,
  command: "image content metadata",
  version: "0.1.0",
  data: { width: 640 }
};

const transcript: Transcript = {
  kind: "transcript",
  schemaVersion: "1.0",
  sourceFingerprint: { algorithm: "sha256", value: "a".repeat(64) },
  language: "en",
  segments: [{ id: "seg-001", startMs: 0, endMs: 100, text: "Hello" }]
};

void result;
void transcript;
