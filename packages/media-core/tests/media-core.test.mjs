import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CliError } from "@dkplus/contracts";
import { fixturePath } from "@dkplus/testing";

import {
  createFilmstrip,
  extractAudio,
  fingerprintFile,
  loadImage,
  probeAudio,
  probeVideo,
  readImageMetadata,
  watermarkImage
} from "../dist/index.js";

const videoFixture = fixturePath("short-video.mp4");
const audioFixture = fixturePath("short-audio.wav");
const imageFixture = fixturePath("sample.png");

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "dkplus-media-core-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("media adapters", () => {
  it("normalizes metadata from short deterministic audio and video fixtures", async () => {
    const [audio, video] = await Promise.all([probeAudio(audioFixture), probeVideo(videoFixture)]);

    assert.equal(audio.codec, "pcm_s16le");
    assert.equal(audio.sampleRate, 44100);
    assert.equal(audio.channels, 1);
    assert.ok(audio.durationMs >= 450 && audio.durationMs <= 550);
    assert.deepEqual(
      { width: video.width, height: video.height, codec: video.codec, fps: video.fps },
      { width: 160, height: 120, codec: "h264", fps: 1 }
    );
    assert.ok(video.durationMs >= 3900 && video.durationMs <= 4100);
  });

  it("extracts audio without using a shell", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "audio.wav");
      await extractAudio(videoFixture, outputPath);

      const metadata = await probeAudio(outputPath);
      assert.equal(metadata.channels, 1);
      assert.equal(metadata.sampleRate, 44100);
    });
  });

  it("creates a two-by-two filmstrip from four requested timestamps at the requested dimensions", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "filmstrip.png");
      const result = await createFilmstrip(videoFixture, outputPath, {
        timestamps: [0.25, 1.25, 2.25, 2.75],
        width: 320,
        height: 180
      });

      assert.deepEqual(result.timestamps, [0.25, 1.25, 2.25, 2.75]);
      assert.deepEqual(await readImageMetadata(outputPath), {
        width: 320,
        height: 180,
        format: "png",
        hasAlpha: false
      });
    });
  });

  it("loads JPEG, PNG, and WebP images through Sharp", async () => {
    const images = await Promise.all(
      ["sample.jpg", "sample.png", "sample.webp"].map(async (name) => {
        const image = await loadImage(fixturePath(name));
        return image.metadata();
      })
    );

    assert.deepEqual(
      images.map(({ width, height, format }) => ({ width, height, format })),
      [
        { width: 80, height: 60, format: "jpeg" },
        { width: 80, height: 60, format: "png" },
        { width: 80, height: 60, format: "webp" }
      ]
    );
  });

  it("writes a watermarked image at the source dimensions and protects existing output", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "watermarked.png");
      const result = await watermarkImage(imageFixture, outputPath, { text: "dkplus" });

      assert.deepEqual(result, { width: 80, height: 60, format: "png", hasAlpha: false });
      await assert.rejects(
        () => watermarkImage(imageFixture, outputPath, { text: "dkplus" }),
        (error) => error instanceof CliError && error.code === "OUTPUT_EXISTS"
      );
    });
  });

  it("returns a stable lowercase streaming SHA-256 file fingerprint", async () => {
    const [first, second, contents] = await Promise.all([
      fingerprintFile(imageFixture),
      fingerprintFile(imageFixture),
      readFile(imageFixture)
    ]);

    assert.deepEqual(first, second);
    assert.deepEqual(first, {
      algorithm: "sha256",
      value: createHash("sha256").update(contents).digest("hex")
    });
    assert.match(first.value, /^[a-f0-9]{64}$/u);
  });

  it("maps unavailable tools and corrupt media to sanitized CLI errors", async () => {
    await assert.rejects(
      () => probeVideo(videoFixture, { ffprobePath: "dkplus-no-such-ffprobe" }),
      (error) => error instanceof CliError && error.code === "MEDIA_TOOL_UNAVAILABLE"
    );
    await assert.rejects(
      () => probeVideo(fixturePath("not-media.bin")),
      (error) =>
        error instanceof CliError &&
        error.code === "MEDIA_PROCESS_FAILED" &&
        error.message === "Media processing failed." &&
        error.details !== undefined &&
        !JSON.stringify(error.details).includes("not-media.bin")
    );
  });
});
