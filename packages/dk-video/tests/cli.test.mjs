import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createMockProvider } from "@dkplus/ai-core";
import { fixturePath } from "@dkplus/testing";

import { createVideoFilmstrip, extractVideoSubtitles } from "../dist/index.js";
import { runVideoCli } from "../dist/cli.js";

const videoPath = fixturePath("short-video.mp4");
const commandNames = [
  ["probe"],
  ["audio"],
  ["filmstrip"],
  ["subtitles"],
  ["content", "summary"],
  ["content", "keywords"],
  ["content", "highlights"],
  ["analyze"]
];

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
  const directory = await mkdtemp(join(tmpdir(), "dk-video-cli-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("dk-video CLI", () => {
  it("shows help and version envelopes and exposes a schema for all eight commands", async () => {
    const help = writers();
    assert.equal((await runVideoCli(["--help", "--json"], help.writers)).exitCode, 0);
    assert.equal(JSON.parse(help.stdout.join("")).success, true);

    const version = writers();
    assert.equal((await runVideoCli(["--version", "--json"], version.writers)).exitCode, 0);
    assert.equal(JSON.parse(version.stdout.join("")).data.version, "0.1.0");

    for (const command of commandNames) {
      const output = writers();
      const result = await runVideoCli([...command, "--schema", "--json"], output.writers);
      const envelope = JSON.parse(output.stdout.join(""));
      assert.equal(result.exitCode, 0, command.join(" "));
      assert.equal(envelope.data.name, command.join(" "));
      assert.equal(envelope.data.inputSchema.type, "object");
      assert.equal(envelope.data.outputSchema.type, "object");
    }
  });

  it("emits progress only in JSONL mode and keeps normal JSON to one final envelope", async () => {
    const json = writers();
    assert.equal((await runVideoCli(["probe", videoPath, "--json"], json.writers)).exitCode, 0);
    assert.equal(json.stdout.length, 1);
    assert.equal(JSON.parse(json.stdout[0]).data.kind, "video-probe");

    const jsonl = writers();
    assert.equal((await runVideoCli(["probe", videoPath, "--jsonl"], jsonl.writers)).exitCode, 0);
    assert.equal(JSON.parse(jsonl.stdout[0]).type, "progress");
    assert.equal(JSON.parse(jsonl.stdout[1]).success, true);
  });

  it("returns typed non-zero errors for malformed and unknown commands", async () => {
    const malformed = writers();
    assert.equal((await runVideoCli(["probe", "--json"], malformed.writers)).exitCode, 1);
    assert.equal(JSON.parse(malformed.stdout.join("")).error.code, "INVALID_ARGUMENT");

    const unknown = writers();
    assert.equal(
      (await runVideoCli(["generate", videoPath, "--json"], unknown.writers)).exitCode,
      1
    );
    assert.equal(JSON.parse(unknown.stdout.join("")).error.code, "UNKNOWN_COMMAND");
  });

  it("honors global force for existing four-frame filmstrip outputs", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "filmstrip.png");
      await writeFile(outputPath, "occupied");

      const blocked = writers();
      const blockedResult = await runVideoCli(
        [
          "filmstrip",
          join(directory, "unavailable-filmstrip-input.mp4"),
          "--output",
          outputPath,
          "--json"
        ],
        blocked.writers
      );
      assert.equal(blockedResult.exitCode, 1);
      assert.equal(JSON.parse(blocked.stdout.join("")).error.code, "OUTPUT_EXISTS");

      const forced = writers();
      const forcedResult = await runVideoCli(
        ["filmstrip", videoPath, "--output", outputPath, "--force", "--json"],
        forced.writers
      );
      const artifact = JSON.parse(forced.stdout.join("")).data;
      assert.equal(forcedResult.exitCode, 0);
      assert.equal(artifact.outputPath, outputPath);
      assert.deepEqual(artifact.timestamps, [0, 1, 2, 3]);
    });
  });

  it("returns MISSING_REQUIRED_ARTIFACT when analyze prerequisites are omitted", async () => {
    const output = writers();
    const result = await runVideoCli(["analyze", videoPath, "--json"], output.writers);

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(output.stdout.join("")).error.code, "MISSING_REQUIRED_ARTIFACT");
  });

  it("routes content commands through an explicit local config profile without network access", async () => {
    await withTemporaryDirectory(async (directory) => {
      const configPath = join(directory, "video-ai.json");
      const transcriptPath = join(directory, "transcript.json");
      const filmstripPath = join(directory, "filmstrip.json");
      const filmstrip = await createVideoFilmstrip(videoPath, join(directory, "filmstrip.png"), {
        timestamps: [0, 1, 2, 3],
        width: 320,
        height: 180
      });
      const subtitles = await extractVideoSubtitles(videoPath, {
        transcriber: {
          async transcribe(task) {
            return {
              kind: "transcript",
              schemaVersion: "1.0",
              sourceFingerprint: task.sourceFingerprint,
              language: "en",
              segments: [{ id: "seg-001", startMs: 0, endMs: 1000, text: "Hello video." }]
            };
          }
        }
      });
      await Promise.all([
        writeFile(transcriptPath, JSON.stringify(subtitles)),
        writeFile(filmstripPath, JSON.stringify(filmstrip)),
        writeFile(
          configPath,
          JSON.stringify({
            profiles: [
              {
                id: "video-content",
                provider: "openai-compatible",
                features: ["video.content.*"],
                config: {
                  baseUrl: "https://example.test/v1",
                  apiKey: "test-key",
                  model: "test-model"
                }
              }
            ]
          })
        )
      ]);
      const features = [];
      const providerFactory = (profile) => {
        assert.equal(profile.id, "video-content");
        return createMockProvider((task) => {
          features.push(task.feature);
          switch (task.feature) {
            case "video.content.summary":
              return { summary: "A short video.", topics: ["test"], keyPoints: ["hello"] };
            case "video.content.keywords":
              return { keywords: ["test"] };
            case "video.content.highlights":
              return {
                highlights: [
                  { startMs: 0, endMs: 1000, title: "Opening", rationale: "Introduces it." }
                ]
              };
            default:
              throw new Error(`Unexpected feature: ${task.feature}`);
          }
        });
      };

      for (const command of ["summary", "keywords", "highlights"]) {
        const output = writers();
        const result = await runVideoCli(
          [
            "content",
            command,
            videoPath,
            "--transcript",
            transcriptPath,
            "--filmstrip",
            filmstripPath,
            "--config",
            configPath,
            "--json"
          ],
          { ...output.writers, providerFactory }
        );
        assert.equal(result.exitCode, 0, command);
        assert.equal(JSON.parse(output.stdout.join("")).success, true);
      }
      assert.deepEqual(features.sort(), [
        "video.content.highlights",
        "video.content.keywords",
        "video.content.summary"
      ]);
    });
  });

  it("publishes exactly the eight video commands and excludes generate", async () => {
    const manifestPath = fileURLToPath(new URL("../commands.json", import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.deepEqual(manifest.commands.map((command) => command.command).sort(), [
      "analyze",
      "audio",
      "content highlights",
      "content keywords",
      "content summary",
      "filmstrip",
      "probe",
      "subtitles"
    ]);
  });
});
