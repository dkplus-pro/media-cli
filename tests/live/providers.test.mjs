import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const liveEnabled = process.env.DKPLUS_LIVE_AI === "1";
const skipped = !liveEnabled ? "Set DKPLUS_LIVE_AI=1 to enable live provider coverage." : false;
const fixturePath = (name) =>
  fileURLToPath(new URL(`../../packages/testing/fixtures/${name}`, import.meta.url));

const qwenAnalysisResponseSchema = {
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Qwen response must be a JSON object.");
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Qwen response must be a plain JSON object.");
    }
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "analysis" || !Object.hasOwn(value, "analysis")) {
      throw new TypeError("Qwen response must contain exactly the analysis key.");
    }
    if (typeof value.analysis !== "string" || value.analysis.trim().length === 0) {
      throw new TypeError("Qwen analysis must be a non-empty string.");
    }
    return { analysis: value.analysis };
  }
};

it("strictly validates the local Qwen response contract without a root dependency", () => {
  assert.deepEqual(qwenAnalysisResponseSchema.parse({ analysis: "Valid." }), {
    analysis: "Valid."
  });
  assert.throws(() => qwenAnalysisResponseSchema.parse({ analysis: "Valid.", extra: true }));
  assert.throws(() => qwenAnalysisResponseSchema.parse({ analysis: "" }));
  assert.throws(() =>
    qwenAnalysisResponseSchema.parse(
      Object.assign(Object.create({ analysis: "Inherited." }), { unrelated: true })
    )
  );
});

describe("live AI provider coverage", () => {
  it("summarizes canonical text with Azure GPT-4o", { skip: skipped }, async () => {
    const { azureProvider, runSanitizedLive } = await import("./helpers.mjs");
    const { summarizeTranscript, transcriptSummarySchema } =
      await import("../../packages/dk-audio/dist/speech.js");

    const result = await runSanitizedLive("Azure text summary", async () =>
      summarizeTranscript(
        {
          kind: "transcript",
          schemaVersion: "1.0",
          sourceFingerprint: { algorithm: "sha256", value: "a".repeat(64) },
          language: "en",
          segments: [
            {
              id: "live-001",
              startMs: 0,
              endMs: 1000,
              text: "The project update is complete and the next review is tomorrow."
            }
          ]
        },
        { provider: await azureProvider() }
      )
    );

    transcriptSummarySchema.parse(result);
    assert.ok(result.summary.trim().length > 0);
  });

  it("describes one local image with Azure", { skip: skipped }, async () => {
    const { azureProvider, runSanitizedLive } = await import("./helpers.mjs");
    const { describeImage, imageDescriptionResultSchema } =
      await import("../../packages/dk-image/dist/content.js");

    const result = await runSanitizedLive("Azure image description", async () =>
      describeImage(fixturePath("sample.png"), { provider: await azureProvider() })
    );

    imageDescriptionResultSchema.parse(result);
    assert.ok(result.description.trim().length > 0);
  });

  it("summarizes a transcript and filmstrip with Azure", { skip: skipped }, async () => {
    const { azureProvider, runSanitizedLive } = await import("./helpers.mjs");
    const { createVideoFilmstrip } = await import("../../packages/dk-video/dist/media.js");
    const { summarizeVideoContent, videoContentSummarySchema } =
      await import("../../packages/dk-video/dist/content.js");
    const directory = await mkdtemp(join(tmpdir(), "dkplus-live-video-"));
    const videoPath = fixturePath("short-video.mp4");
    try {
      const filmstrip = await createVideoFilmstrip(videoPath, join(directory, "filmstrip.png"), {
        timestamps: [0, 1, 2, 3],
        width: 320,
        height: 180
      });
      const result = await runSanitizedLive("Azure video summary", async () =>
        summarizeVideoContent(videoPath, {
          provider: await azureProvider(),
          filmstrip,
          transcript: {
            kind: "transcript",
            schemaVersion: "1.0",
            sourceFingerprint: filmstrip.sourceFingerprint,
            language: "en",
            segments: [
              {
                id: "live-video-001",
                startMs: 0,
                endMs: 1000,
                text: "This short fixture video is used for a live provider schema check."
              }
            ]
          }
        })
      );

      videoContentSummarySchema.parse(result);
      assert.ok(result.summary.trim().length > 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it(
    "performs safe text-only analysis with a Qwen-compatible provider",
    { skip: skipped },
    async () => {
      const { qwenProvider, runSanitizedLive } = await import("./helpers.mjs");

      const result = await runSanitizedLive("Qwen text analysis", async () =>
        (await qwenProvider()).execute({
          feature: "live.qwen.safe-text-analysis",
          prompt:
            'Return a single JSON object with exactly one key: "analysis" (string). Do not use Markdown or wrap the object. Provide a concise analysis of this harmless sentence: The test checks schema validation only.',
          responseSchema: qwenAnalysisResponseSchema
        })
      );

      qwenAnalysisResponseSchema.parse(result);
      assert.ok(result.analysis.trim().length > 0);
    }
  );
});
