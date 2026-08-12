import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createMockProvider } from "@dkplus/ai-core";
import { CliError } from "@dkplus/contracts";
import { fixturePath } from "@dkplus/testing";

import {
  analyzeVideo,
  createVideoFilmstrip,
  extractVideoAudio,
  extractVideoSubtitles,
  extractVideoHighlights,
  extractVideoKeywords,
  probeVideo,
  summarizeVideoContent
} from "../dist/index.js";

const videoPath = fixturePath("short-video.mp4");

async function withTemporaryDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), "dk-video-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function provider(tasks) {
  return createMockProvider((task) => {
    tasks.push(task);
    switch (task.feature) {
      case "video.content.summary":
        return { summary: "A short test video.", topics: ["test"], keyPoints: ["hello"] };
      case "video.content.keywords":
        return { keywords: ["test", "video"] };
      case "video.content.highlights":
        return {
          highlights: [
            { startMs: 0, endMs: 1000, title: "Opening", rationale: "Introduces the video." }
          ]
        };
      default:
        throw new Error(`Unexpected feature: ${task.feature}`);
    }
  });
}

describe("dk-video public APIs", () => {
  it("wraps deterministic probe, audio, filmstrip, and subtitle artifacts with the video source fingerprint", async () => {
    await withTemporaryDirectory(async (directory) => {
      const [probe, audio, filmstrip, subtitles] = await Promise.all([
        probeVideo(videoPath),
        extractVideoAudio(videoPath, join(directory, "audio.wav")),
        createVideoFilmstrip(videoPath, join(directory, "filmstrip.png"), {
          timestamps: [0, 1, 2, 3],
          width: 320,
          height: 180
        }),
        extractVideoSubtitles(videoPath, {
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
        })
      ]);

      for (const artifact of [probe, audio, filmstrip, subtitles]) {
        assert.equal(artifact.sourceFingerprint.algorithm, "sha256");
        assert.match(artifact.sourceFingerprint.value, /^[a-f0-9]{64}$/u);
      }
      assert.equal(probe.kind, "video-probe");
      assert.equal(audio.kind, "video-audio");
      assert.equal(filmstrip.kind, "video-filmstrip");
      assert.equal(subtitles.kind, "transcript");
      assert.equal(subtitles.segments[0].text, "Hello video.");
    });
  });

  it("returns the adapter error before accessing an unavailable subtitle video", async () => {
    await assert.rejects(
      () => extractVideoSubtitles(join(tmpdir(), "dk-video-unavailable-subtitle-input.mp4")),
      (error) => error instanceof CliError && error.code === "AUDIO_TRANSCRIBER_UNAVAILABLE"
    );
  });

  it("refuses an existing filmstrip output unless force overwrites it with four frames", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "filmstrip.png");
      const options = { timestamps: [0, 1, 2, 3], width: 320, height: 180 };
      await writeFile(outputPath, "occupied");

      await assert.rejects(
        () =>
          createVideoFilmstrip(
            join(directory, "unavailable-filmstrip-input.mp4"),
            outputPath,
            options
          ),
        (error) => error instanceof CliError && error.code === "OUTPUT_EXISTS"
      );

      const filmstrip = await createVideoFilmstrip(videoPath, outputPath, {
        ...options,
        force: true
      });
      assert.equal(filmstrip.outputPath, outputPath);
      assert.deepEqual(filmstrip.timestamps, [0, 1, 2, 3]);
      assert.equal(filmstrip.width, 320);
      assert.equal(filmstrip.height, 180);
    });
  });

  it("rejects invalid filmstrip output extensions before force can overwrite an existing file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "filmstrip.txt");
      await writeFile(outputPath, "preserve this output");

      for (const force of [false, true]) {
        await assert.rejects(
          () =>
            createVideoFilmstrip(videoPath, outputPath, {
              timestamps: [0, 1, 2, 3],
              width: 320,
              height: 180,
              force
            }),
          (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT"
        );
        assert.equal(await readFile(outputPath, "utf8"), "preserve this output");
      }
    });
  });

  it("sends timestamped transcript content and the linked filmstrip image through the exact content features", async () => {
    await withTemporaryDirectory(async (directory) => {
      const tasks = [];
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

      const contentProvider = provider(tasks);
      const [summary, keywords, highlights] = await Promise.all([
        summarizeVideoContent(videoPath, {
          transcript: subtitles,
          filmstrip,
          provider: contentProvider
        }),
        extractVideoKeywords(videoPath, {
          transcript: subtitles,
          filmstrip,
          provider: contentProvider
        }),
        extractVideoHighlights(videoPath, {
          transcript: subtitles,
          filmstrip,
          provider: contentProvider
        })
      ]);

      assert.deepEqual(tasks.map((task) => task.feature).sort(), [
        "video.content.highlights",
        "video.content.keywords",
        "video.content.summary"
      ]);
      for (const task of tasks) {
        assert.match(task.prompt, /\[00:00\.000-00:01\.000\] Hello video\./u);
        assert.equal(task.images.length, 1);
        assert.equal(task.images[0].mimeType, "image/png");
        assert.match(task.images[0].base64Data, /\S/u);
      }
      assert.equal(summary.kind, "video-content-summary");
      assert.equal(keywords.kind, "video-content-keywords");
      assert.equal(highlights.kind, "video-content-highlights");
    });
  });

  it("rejects transcript or filmstrip artifacts from a different video source", async () => {
    await withTemporaryDirectory(async (directory) => {
      const filmstrip = await createVideoFilmstrip(videoPath, join(directory, "filmstrip.png"), {
        timestamps: [0, 1, 2, 3],
        width: 320,
        height: 180
      });
      const transcript = {
        kind: "transcript",
        schemaVersion: "1.0",
        sourceFingerprint: filmstrip.sourceFingerprint,
        language: "en",
        segments: []
      };

      await assert.rejects(
        () =>
          summarizeVideoContent(videoPath, {
            transcript,
            filmstrip: {
              ...filmstrip,
              sourceFingerprint: { algorithm: "sha256", value: "b".repeat(64) }
            },
            provider: provider([])
          }),
        (error) => error instanceof CliError && error.code === "ARTIFACT_SOURCE_MISMATCH"
      );
    });
  });

  it("composes only explicitly supplied matching prerequisite artifacts", async () => {
    await withTemporaryDirectory(async (directory) => {
      const tasks = [];
      const [probe, audio, filmstrip, subtitles] = await Promise.all([
        probeVideo(videoPath),
        extractVideoAudio(videoPath, join(directory, "audio.wav")),
        createVideoFilmstrip(videoPath, join(directory, "filmstrip.png"), {
          timestamps: [0, 1, 2, 3],
          width: 320,
          height: 180
        }),
        extractVideoSubtitles(videoPath, {
          transcriber: {
            async transcribe(task) {
              return {
                kind: "transcript",
                schemaVersion: "1.0",
                sourceFingerprint: task.sourceFingerprint,
                language: "en",
                segments: []
              };
            }
          }
        })
      ]);
      const contentProvider = provider(tasks);
      const [summary, keywords, highlights] = await Promise.all([
        summarizeVideoContent(videoPath, {
          transcript: subtitles,
          filmstrip,
          provider: contentProvider
        }),
        extractVideoKeywords(videoPath, {
          transcript: subtitles,
          filmstrip,
          provider: contentProvider
        }),
        extractVideoHighlights(videoPath, {
          transcript: subtitles,
          filmstrip,
          provider: contentProvider
        })
      ]);

      const analysis = await analyzeVideo(videoPath, {
        dependencies: { probe, audio, filmstrip, subtitles, summary, keywords, highlights }
      });

      assert.deepEqual(Object.keys(analysis).sort(), [
        "audio",
        "filmstrip",
        "highlights",
        "keywords",
        "probe",
        "subtitles",
        "summary"
      ]);
      assert.equal(tasks.length, 3);
    });
  });

  it("returns MISSING_REQUIRED_ARTIFACT instead of silently creating analyze prerequisites", async () => {
    await assert.rejects(
      () => analyzeVideo(videoPath, { dependencies: {} }),
      (error) => error instanceof CliError && error.code === "MISSING_REQUIRED_ARTIFACT"
    );
  });
});
