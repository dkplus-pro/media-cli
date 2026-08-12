import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createMockProvider } from "@dkplus/ai-core";

import { runAudioCli } from "../dist/cli.js";

const transcript = {
  kind: "transcript",
  schemaVersion: "1.0",
  sourceFingerprint: { algorithm: "sha256", value: "a".repeat(64) },
  language: "en",
  segments: [{ id: "seg-001", startMs: 0, endMs: 1, text: "Hello." }]
};

function writers() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, writers: { stdout: { write: (line) => stdout.push(line) }, stderr: { write: (line) => stderr.push(line) } } };
}

describe("dk-audio CLI", () => {
  it("shows help, version, and a command schema", async () => {
    const output = writers();
    assert.equal((await runAudioCli(["--help"], { ...output.writers })).exitCode, 0);
    assert.match(output.stdout.join(""), /speech transcribe/u);

    const version = writers();
    assert.equal((await runAudioCli(["--version"], { ...version.writers })).exitCode, 0);
    assert.match(version.stdout.join(""), /0\.1\.0/u);

    const schema = writers();
    assert.equal((await runAudioCli(["speech", "summarize", "--schema", "--json"], { ...schema.writers })).exitCode, 0);
    const envelope = JSON.parse(schema.stdout.join(""));
    assert.equal(envelope.success, true);
    assert.equal(envelope.data.name, "speech summarize");
  });

  it("emits one JSON envelope for a valid command", async () => {
    const output = writers();
    const exitCode = await runAudioCli(
      ["speech", "summarize", JSON.stringify(transcript), "--json", "--config", "audio.json"],
      {
        ...output.writers,
        provider: createMockProvider(() => ({
          summary: "Greeting.",
          topics: [],
          keyPoints: [],
          participants: [],
          decisions: [],
          questions: []
        }))
      }
    );

    assert.equal(exitCode.exitCode, 0);
    assert.equal(output.stdout.length, 1);
    assert.equal(JSON.parse(output.stdout[0]).success, true);
  });

  it("returns a non-zero typed error envelope for malformed transcript input", async () => {
    const output = writers();
    const result = await runAudioCli(["speech", "summarize", "{bad-json", "--json"], output.writers);

    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(output.stdout.join(""));
    assert.deepEqual(envelope.error.code, "INVALID_TRANSCRIPT");
  });

  it("returns a non-zero typed configuration error for raw audio without an adapter", async () => {
    const output = writers();
    const result = await runAudioCli(["speech", "transcribe", "clip.wav", "--json"], output.writers);

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(output.stdout.join("")).error.code, "AUDIO_TRANSCRIBER_UNAVAILABLE");
  });

  it("publishes exactly the six phase-one commands", async () => {
    const manifestPath = fileURLToPath(new URL("../commands.json", import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.deepEqual(
      manifest.commands.map((command) => command.command).sort(),
      [
        "music analyze",
        "music emotion",
        "music metadata",
        "speech summarize",
        "speech transcribe",
        "speech translate"
      ]
    );
  });
});
