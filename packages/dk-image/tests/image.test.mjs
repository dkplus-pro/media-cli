import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createMockProvider } from "@dkplus/ai-core";
import { CliError } from "@dkplus/contracts";
import { fixturePath } from "@dkplus/testing";

import {
  analyzeImage,
  describeImage,
  extractImageKeywords,
  extractImageOcr,
  metadata,
  scoreImage,
  watermarkImageAsset
} from "../dist/index.js";

const imagePath = fixturePath("sample.png");

function imageProvider(onTask = () => {}) {
  return createMockProvider((task) => {
    onTask(task);
    switch (task.feature) {
      case "image.content.describe":
        return { description: "A sample image." };
      case "image.content.keywords":
        return { keywords: ["sample", "image"] };
      case "image.content.ocr":
        return { text: "Sample", blocks: [{ text: "Sample" }] };
      case "image.content.score":
        return { score: 8.5, rationale: "Clear composition." };
      default:
        throw new Error(`Unexpected feature: ${task.feature}`);
    }
  });
}

async function withTemporaryDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), "dk-image-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("dk-image public APIs", () => {
  it("reads deterministic local metadata with its source fingerprint", async () => {
    const result = await metadata(imagePath);

    assert.deepEqual(
      {
        kind: result.kind,
        width: result.width,
        height: result.height,
        format: result.format,
        hasAlpha: result.hasAlpha
      },
      { kind: "image-metadata", width: 80, height: 60, format: "png", hasAlpha: false }
    );
    assert.equal(result.sourceFingerprint.algorithm, "sha256");
    assert.match(result.sourceFingerprint.value, /^[a-f0-9]{64}$/u);
  });

  it("sends a locally loaded image and source fingerprint through each content feature", async () => {
    const tasks = [];
    const provider = imageProvider((task) => tasks.push(task));

    const [description, keywords, ocr, score] = await Promise.all([
      describeImage(imagePath, { provider }),
      extractImageKeywords(imagePath, { provider }),
      extractImageOcr(imagePath, { provider }),
      scoreImage(imagePath, { provider })
    ]);

    assert.deepEqual(tasks.map((task) => task.feature).sort(), [
      "image.content.describe",
      "image.content.keywords",
      "image.content.ocr",
      "image.content.score"
    ]);
    for (const task of tasks) {
      assert.equal(task.images.length, 1);
      assert.equal(task.images[0].mimeType, "image/png");
      assert.match(task.images[0].base64Data, /\S/u);
      assert.match(task.prompt, /sourceFingerprint/u);
    }
    assert.equal(description.description, "A sample image.");
    assert.deepEqual(keywords.keywords, ["sample", "image"]);
    assert.equal(ocr.text, "Sample");
    assert.equal(score.score, 8.5);
  });

  it("requires the exact JSON object contract for an image description", async () => {
    const tasks = [];

    await describeImage(imagePath, { provider: imageProvider((task) => tasks.push(task)) });

    assert.equal(tasks.length, 1);
    assert.match(tasks[0].prompt, /single JSON object/u);
    assert.match(tasks[0].prompt, /exactly one key: "description" \(non-empty string\)/u);
    assert.match(tasks[0].prompt, /Do not use Markdown or wrap the object/u);
  });

  it("rejects provider scores outside the inclusive 0 through 10 range", async () => {
    await assert.rejects(
      () =>
        scoreImage(imagePath, {
          provider: createMockProvider(() => ({ score: 10.1, rationale: "Too high." }))
        }),
      (error) => error instanceof CliError && error.code === "AI_PROVIDER_RESPONSE_INVALID"
    );
  });

  it("combines exactly metadata, description, keywords, ocr, and score", async () => {
    const result = await analyzeImage(imagePath, { provider: imageProvider() });

    assert.deepEqual(Object.keys(result).sort(), [
      "description",
      "keywords",
      "metadata",
      "ocr",
      "score"
    ]);
    assert.equal(result.metadata.kind, "image-metadata");
    assert.equal(result.description.kind, "image-description");
    assert.equal(result.keywords.kind, "image-keywords");
    assert.equal(result.ocr.kind, "image-ocr");
    assert.equal(result.score.kind, "image-score");
  });

  it("rejects a composite dependency whose source fingerprint differs from the requested image", async () => {
    const sourceMetadata = await metadata(imagePath);
    const mismatchedDescription = {
      ...(await describeImage(imagePath, { provider: imageProvider() })),
      sourceFingerprint: { algorithm: "sha256", value: "b".repeat(64) }
    };

    await assert.rejects(
      () =>
        analyzeImage(imagePath, {
          provider: imageProvider(),
          dependencies: { metadata: sourceMetadata, description: mismatchedDescription }
        }),
      (error) => error instanceof CliError && error.code === "ARTIFACT_SOURCE_MISMATCH"
    );
  });

  it("writes watermarks only to a distinct non-existing output unless force is set", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "watermarked.png");
      await copyFile(imagePath, outputPath);

      await assert.rejects(
        () => watermarkImageAsset(imagePath, outputPath, { text: "dkplus" }),
        (error) => error instanceof CliError && error.code === "OUTPUT_EXISTS"
      );
      await assert.rejects(
        () => watermarkImageAsset(imagePath, imagePath, { text: "dkplus", force: true }),
        (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT"
      );

      const result = await watermarkImageAsset(imagePath, outputPath, {
        text: "dkplus",
        force: true
      });
      assert.equal(result.kind, "image-watermark");
      assert.equal(result.output.width, 80);
      assert.equal(result.output.height, 60);
    });
  });
});
