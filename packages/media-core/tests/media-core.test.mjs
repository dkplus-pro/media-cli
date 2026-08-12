import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

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
const filmstripFixture = fixturePath("filmstrip-source.mp4");
const audioFixture = fixturePath("short-audio.wav");
const imageFixture = fixturePath("sample.png");
const execFile = promisify(execFileCallback);

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "dkplus-media-core-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function frameAtTimestamp(path, timestamp, width, height, directory) {
  const outputPath = join(directory, `frame-${timestamp}.png`);
  await execFile("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-ss",
    String(timestamp),
    "-i",
    path,
    "-vf",
    `scale=${width}:${height},setsar=1`,
    "-frames:v",
    "1",
    outputPath
  ]);
  return (await loadImage(outputPath)).raw().toBuffer();
}

async function filmstripQuadrant(path, left, top, width, height) {
  return (await loadImage(path)).extract({ left, top, width, height }).raw().toBuffer();
}

function unsupportedLinkError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)
  );
}

async function assertAliasDoesNotOverwriteSource(createOutputAlias, writeMedia) {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "source.mp4");
    const outputPath = join(directory, "output.mp4");
    await copyFile(videoFixture, inputPath);
    const originalContents = await readFile(inputPath);

    try {
      await createOutputAlias(inputPath, outputPath);
    } catch (error) {
      if (unsupportedLinkError(error)) {
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => writeMedia(inputPath, outputPath),
      (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT"
    );
    assert.deepEqual(await readFile(inputPath), originalContents);
  });
}

async function assertAtomicPublicationDoesNotReplaceSource(writeMedia) {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "source.mp4");
    const outputPath = join(directory, "output.png");
    await copyFile(videoFixture, inputPath);
    const originalContents = await readFile(inputPath);

    await writeMedia(inputPath, outputPath, {
      force: true,
      processRunner: async (_command, argumentsList) => {
        const temporaryOutputPath = argumentsList.at(-1);
        assert.equal(typeof temporaryOutputPath, "string");
        await writeFile(temporaryOutputPath, "generated output");
        await symlink(inputPath, outputPath);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    assert.deepEqual(await readFile(inputPath), originalContents);
    assert.equal(await readFile(outputPath, "utf8"), "generated output");
  });
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

  it("stops before FFmpeg when the audio output path cannot be inspected", async () => {
    let processWasStarted = false;

    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "audio.wav");
      await assert.rejects(
        () =>
          extractAudio(videoFixture, outputPath, {
            pathInspector: async (path) => {
              if (path !== videoFixture) {
                throw Object.assign(new Error("denied"), { code: "EACCES" });
              }
              return stat(path);
            },
            processRunner: async () => {
              processWasStarted = true;
              return { exitCode: 0, stdout: "", stderr: "" };
            }
          }),
        (error) =>
          error instanceof CliError &&
          error.code === "INVALID_ARGUMENT" &&
          !error.message.includes(outputPath)
      );
    });
    assert.equal(processWasStarted, false);
  });

  it("preserves media processing failures when temporary output cleanup fails", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "audio.wav");
      await assert.rejects(
        () =>
          extractAudio(videoFixture, outputPath, {
            processRunner: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
            cleanupDirectory: async () => {
              throw new Error("raw cleanup failure");
            }
          }),
        (error) =>
          error instanceof CliError &&
          error.code === "MEDIA_PROCESS_FAILED" &&
          error.message === "Media processing failed." &&
          !error.message.includes("raw cleanup failure")
      );
    });
  });

  it("refuses separate pre-existing media-core outputs unless force is explicit", async () => {
    await withTemporaryDirectory(async (directory) => {
      const audioOutputPath = join(directory, "audio.wav");
      const filmstripOutputPath = join(directory, "filmstrip.png");
      await Promise.all([
        writeFile(audioOutputPath, "preserve audio output"),
        writeFile(filmstripOutputPath, "preserve filmstrip output")
      ]);

      await assert.rejects(
        () => extractAudio(videoFixture, audioOutputPath),
        (error) => error instanceof CliError && error.code === "OUTPUT_EXISTS"
      );
      await assert.rejects(
        () =>
          createFilmstrip(videoFixture, filmstripOutputPath, {
            timestamps: [0, 1, 2, 3],
            width: 320,
            height: 180
          }),
        (error) => error instanceof CliError && error.code === "OUTPUT_EXISTS"
      );
      assert.equal(await readFile(audioOutputPath, "utf8"), "preserve audio output");
      assert.equal(await readFile(filmstripOutputPath, "utf8"), "preserve filmstrip output");
    });
  });

  it("publishes force-enabled audio and filmstrip outputs without replacing a swapped source alias", async () => {
    await assertAtomicPublicationDoesNotReplaceSource((inputPath, outputPath, options) =>
      extractAudio(inputPath, outputPath, options)
    );
    await assertAtomicPublicationDoesNotReplaceSource((inputPath, outputPath, options) =>
      createFilmstrip(inputPath, outputPath, {
        timestamps: [0, 1, 2, 3],
        width: 320,
        height: 180,
        ...options
      })
    );
  });

  it("rejects force-enabled extract-audio outputs that alias the input without altering the source", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "source.mp4");
      await copyFile(videoFixture, inputPath);
      const originalContents = await readFile(inputPath);
      const relativeInputPath = relative(process.cwd(), inputPath);

      await assert.rejects(
        () => extractAudio(relativeInputPath, `./${relativeInputPath}`, { force: true }),
        (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT"
      );
      assert.deepEqual(await readFile(inputPath), originalContents);
    });

    for (const createOutputAlias of [
      (inputPath, outputPath) => symlink(inputPath, outputPath),
      (inputPath, outputPath) => link(inputPath, outputPath)
    ]) {
      await assertAliasDoesNotOverwriteSource(createOutputAlias, (inputPath, outputPath) =>
        extractAudio(inputPath, outputPath, { force: true })
      );
    }
  });

  it("rejects filmstrip outputs that alias the input without altering the source", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = join(directory, "source.mp4");
      await copyFile(videoFixture, inputPath);
      const originalContents = await readFile(inputPath);
      const relativeInputPath = relative(process.cwd(), inputPath);

      await assert.rejects(
        () =>
          createFilmstrip(relativeInputPath, `./${relativeInputPath}`, {
            timestamps: [0, 1, 2, 3],
            width: 320,
            height: 180
          }),
        (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT"
      );
      assert.deepEqual(await readFile(inputPath), originalContents);
    });

    for (const createOutputAlias of [
      (inputPath, outputPath) => symlink(inputPath, outputPath),
      (inputPath, outputPath) => link(inputPath, outputPath)
    ]) {
      await assertAliasDoesNotOverwriteSource(createOutputAlias, (inputPath, outputPath) =>
        createFilmstrip(inputPath, outputPath, {
          timestamps: [0, 1, 2, 3],
          width: 320,
          height: 180
        })
      );
    }
  });

  it("creates a two-by-two filmstrip whose quadrants match all four requested timestamps", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outputPath = join(directory, "filmstrip.png");
      const timestamps = [0.25, 1.25, 2.25, 3.25];
      const result = await createFilmstrip(filmstripFixture, outputPath, {
        timestamps,
        width: 320,
        height: 180
      });

      assert.deepEqual(result.timestamps, timestamps);
      assert.deepEqual(await readImageMetadata(outputPath), {
        width: 320,
        height: 180,
        format: "png",
        hasAlpha: false
      });

      const expectedFrames = await Promise.all(
        timestamps.map((timestamp) =>
          frameAtTimestamp(filmstripFixture, timestamp, 160, 90, directory)
        )
      );
      const quadrants = await Promise.all([
        filmstripQuadrant(outputPath, 0, 0, 160, 90),
        filmstripQuadrant(outputPath, 160, 0, 160, 90),
        filmstripQuadrant(outputPath, 0, 90, 160, 90),
        filmstripQuadrant(outputPath, 160, 90, 160, 90)
      ]);

      assert.equal(
        new Set(expectedFrames.map((frame) => createHash("sha256").update(frame).digest("hex")))
          .size,
        4
      );
      assert.deepEqual(quadrants, expectedFrames);
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
      await assert.rejects(
        () =>
          watermarkImage(imageFixture, join(dirname(imageFixture), ".", "sample.png"), {
            text: "dkplus",
            force: true
          }),
        (error) => error instanceof CliError && error.code === "INVALID_ARGUMENT"
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

  it("maps unavailable and non-executable tools and corrupt media to sanitized CLI errors", async () => {
    await assert.rejects(
      () => probeVideo(videoFixture, { ffprobePath: "dkplus-no-such-ffprobe" }),
      (error) => error instanceof CliError && error.code === "MEDIA_TOOL_UNAVAILABLE"
    );
    await withTemporaryDirectory(async (directory) => {
      const unavailablePath = join(directory, "ffprobe");
      await writeFile(unavailablePath, "not executable");
      await chmod(unavailablePath, 0o644);
      await assert.rejects(
        () => probeVideo(videoFixture, { ffprobePath: unavailablePath }),
        (error) => error instanceof CliError && error.code === "MEDIA_TOOL_UNAVAILABLE"
      );
    });
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
