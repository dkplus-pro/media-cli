import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createMockProvider } from "@dkplus/ai-core";
import { fixturePath } from "@dkplus/testing";

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
  return {
    stdout,
    stderr,
    writers: {
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) }
    }
  };
}

async function withTemporaryDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), "dk-audio-cli-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    assert.equal(
      (await runAudioCli(["speech", "summarize", "--schema", "--json"], { ...schema.writers }))
        .exitCode,
      0
    );
    const envelope = JSON.parse(schema.stdout.join(""));
    assert.equal(envelope.success, true);
    assert.equal(envelope.data.name, "speech summarize");
  });

  it("emits one JSON envelope for help and version in JSON mode", async () => {
    const help = writers();
    assert.equal((await runAudioCli(["--help", "--json"], { ...help.writers })).exitCode, 0);
    assert.equal(help.stdout.length, 1);
    const helpEnvelope = JSON.parse(help.stdout[0]);
    assert.equal(helpEnvelope.success, true);
    assert.match(helpEnvelope.data.help, /speech transcribe/u);

    const version = writers();
    assert.equal((await runAudioCli(["--version", "--json"], { ...version.writers })).exitCode, 0);
    assert.equal(version.stdout.length, 1);
    const versionEnvelope = JSON.parse(version.stdout[0]);
    assert.equal(versionEnvelope.success, true);
    assert.equal(versionEnvelope.data.version, "0.1.0");
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

  it("routes summary and music AI commands through an explicit local config profile", async () => {
    await withTemporaryDirectory(async (directory) => {
      const configPath = join(directory, "audio-ai.json");
      await writeFile(
        configPath,
        JSON.stringify({
          profiles: [
            {
              id: "audio-analysis",
              provider: "openai-compatible",
              features: ["audio.speech.summarize", "audio.music.*"],
              config: {
                baseUrl: "https://example.test/v1",
                apiKey: "test-key",
                model: "test-model"
              }
            }
          ]
        })
      );
      const features = [];
      const providerFactory = (profile) => {
        assert.equal(profile.id, "audio-analysis");
        return createMockProvider((task) => {
          features.push(task.feature);
          if (task.feature === "audio.speech.summarize") {
            return {
              summary: "Greeting.",
              topics: [],
              keyPoints: [],
              participants: [],
              decisions: [],
              questions: []
            };
          }
          if (task.feature === "audio.music.emotion") {
            return {
              primaryEmotion: "calm",
              secondaryEmotions: [],
              valence: 0.5,
              arousal: 0.2,
              tension: 0.1
            };
          }
          throw new Error(`Unexpected feature: ${task.feature}`);
        });
      };

      for (const command of [
        ["speech", "summarize", JSON.stringify(transcript)],
        ["music", "emotion", fixturePath("short-audio.wav")],
        ["music", "analyze", fixturePath("short-audio.wav")]
      ]) {
        const output = writers();
        const result = await runAudioCli([...command, "--config", configPath, "--json"], {
          ...output.writers,
          providerFactory
        });
        assert.equal(result.exitCode, 0, command.join(" "));
        assert.equal(JSON.parse(output.stdout.join("")).success, true);
      }

      assert.deepEqual(features, [
        "audio.speech.summarize",
        "audio.music.emotion",
        "audio.music.emotion"
      ]);
    });
  });

  it("returns a non-zero typed error envelope for malformed transcript input", async () => {
    const output = writers();
    const result = await runAudioCli(
      ["speech", "summarize", "{bad-json", "--json"],
      output.writers
    );

    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(output.stdout.join(""));
    assert.deepEqual(envelope.error.code, "INVALID_TRANSCRIPT");
  });

  it("returns a non-zero typed configuration error for raw audio without an adapter", async () => {
    const output = writers();
    const result = await runAudioCli(
      ["speech", "transcribe", "clip.wav", "--json"],
      output.writers
    );

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(output.stdout.join("")).error.code, "AUDIO_TRANSCRIBER_UNAVAILABLE");
  });

  it("translates an audio file through injected raw-audio and transcript adapters", async () => {
    const output = writers();
    const calls = [];
    const result = await runAudioCli(
      ["speech", "translate", fixturePath("short-audio.wav"), "--to", "zh", "--json"],
      {
        ...output.writers,
        transcriber: {
          async transcribe(task) {
            calls.push(task.feature);
            return { ...transcript, sourceFingerprint: task.sourceFingerprint };
          }
        },
        translator: {
          async translate(task) {
            calls.push(task.transcript.sourceFingerprint.value);
            return { ...task.transcript, language: task.targetLanguage };
          }
        }
      }
    );

    assert.equal(result.exitCode, 0);
    const envelope = JSON.parse(output.stdout.join(""));
    assert.equal(envelope.data.language, "zh");
    assert.deepEqual(calls, ["audio.speech.transcribe", envelope.data.sourceFingerprint.value]);
  });

  it("publishes exactly the six phase-one commands", async () => {
    const manifestPath = fileURLToPath(new URL("../commands.json", import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.deepEqual(manifest.commands.map((command) => command.command).sort(), [
      "music analyze",
      "music emotion",
      "music metadata",
      "speech summarize",
      "speech transcribe",
      "speech translate"
    ]);
  });
});
